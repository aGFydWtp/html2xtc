// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { resolveDeviceProfile } from "../devices";
import type { EpubConvertOptions } from "../epub-options";
import { resolveMaxEpubHtmlBytes } from "../jobs";
import {
  extractEpubArchive,
  resolveEpubRelativePath,
  validateEpubMimetype,
} from "./archive";
import type { EpubArchiveLimits } from "./archive";
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  hasDisallowedUrlScheme,
  rasterImageDataUrl,
  sanitizeSvgMarkup,
  svgMarkupToDataUrl,
} from "./assets";
import { sanitizeCss, stripComments } from "./css";
import type { CssUrlResolver } from "./css";
import { locatePackageDocument } from "./container";
import { EpubError } from "./errors";
import { locateNavigationDocument, parseEpubNavigation } from "./navigation";
import { parsePackageDocument } from "./opf";
import {
  chapterSectionId,
  namespacedId,
  sanitizeSpineChapter,
} from "./sanitize";
import type {
  ChapterLinkContext,
  ChapterMarkerPlan,
  ImageResolver,
  SanitizedChapter,
} from "./sanitize";
import type { EpubManifestItem, EpubNavigation, EpubPackageDocument } from "./types";
import { firstByLocalName, parseXmlDocument } from "./xml";
import { formatChapterMarker, normalizeChapterName, XTC_CHAPTER_MARKER_CLASS } from "../../packages/aozora-text/src/index";
import type { XtcChapter } from "../../packages/aozora-text/src/index";

/**
 * Self-contained device-targeted HTML generation (EPUB spec §11-§13,
 * written against an X3-only baseline; device selection — src/devices.ts —
 * was added later and only changes the final correction stylesheet's page
 * geometry, buildFinalCss below): orchestrates archive extraction,
 * package/nav parsing (Phase 2), per-chapter XHTML sanitization
 * (sanitize.ts), CSS collection + sanitization (css.ts), image Data-URL
 * resolution (assets.ts), cover/TOC assembly, layout detection, and the
 * final correction stylesheet — into the single entrypoint Phase 4's
 * Workflow calls: prepareEpubDocument.
 *
 * No colophon (奥付): unlike the URL-render path (src/printhtml.ts, which
 * does append one), EPUB uploads never do. The EPUB itself already IS the
 * source document the user chose to convert — there is no scraped-URL
 * provenance to record — so an appended "converted from my-book.epub at
 * <timestamp>" block would be redundant, not informative.
 */

/** One non-fatal degradation encountered while preparing the document (spec's general "危険な要素を除去したうえで本文変換を継続できる場合は、変換全体を失敗させず縮退動作する" stance) — logged by Phase 4, never shown verbatim to the client. */
export interface EpubWarning {
  code: string;
  detail?: string;
}

export interface PreparedEpubDocument {
  html: string;
  title: string;
  author?: string;
  layout: "horizontal" | "vertical";
  spineItemCount: number;
  imageCount: number;
  warnings: EpubWarning[];
  /**
   * XTC chapter/table-of-contents metadata (top-level TOC entries only —
   * buildXtcChapterPlan below), forwarded by src/workflow.ts's runEpubSource
   * straight into convertInContainer's `chapters` argument, exactly like the
   * TXT-upload pipeline's PreparedTextDocument.chapters. Always `[]` for an
   * EPUB with no usable TOC (locateNavigationDocument found nothing, or
   * every entry failed to resolve) — never inferred from heading tags, per
   * this feature's own design decision (no h1/h2-based fallback, unlike the
   * TXT/Aozora pipelines' heading-level detection).
   */
  chapters: XtcChapter[];
  /** Where the TOC (if any) chapters were built from — observability only (src/workflow.ts logs this alongside chapters.length), never read by any downstream branch. */
  tocSource: EpubNavigation["source"];
}

export interface PrepareEpubDocumentContext {
  /** The uploaded EPUB's original filename — spec §8.4.1's title fallback. */
  filename: string;
  limits: EpubArchiveLimits & {
    /** D11: the generated HTML's own size cap (MAX_EPUB_HTML_BYTES). */
    maxHtmlBytes: number;
  };
}

/**
 * MAX_EPUB_HTML_BYTES resolver (D11). Previously duplicated here and in
 * src/jobs.ts (review "整理" item) — the Workflow (src/workflow.ts) only
 * ever imported the src/jobs.ts copy, so that one is the single source of
 * truth now; this re-export keeps this module's own public surface (and
 * test/epub/html.test.ts's existing import path) unchanged.
 */
export { resolveMaxEpubHtmlBytes };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Breaks any literal "</style" sequence that might have survived sanitization inside a selector/value/comment remnant, so the assembled CSS can never close its `<style>` element early (defense in depth alongside css.ts's own tokenizer — see design note in prepareEpubDocument). */
function styleSafe(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

function isRenderableSpineMediaType(mediaType: string): boolean {
  return mediaType === "application/xhtml+xml" || mediaType === "text/html";
}

// --- image/CSS asset resolution ------------------------------------------

interface ImageResolution {
  resolveRelative: ImageResolver;
  resolveAbsolute: (absPath: string) => string | undefined;
  imageCount: () => number;
}

/**
 * Builds the shared image/SVG resolver used by every chapter, every
 * collected stylesheet, and the cover section: raster bytes become base64
 * data: URLs verbatim; SVG bytes are sanitized (assets.ts) before being
 * encoded. Memoized by absolute archive path — an image referenced from
 * many chapters (a shared cover, a repeated logo) is only decoded once, and
 * `imageCount()` counts unique successfully-resolved paths, not
 * reference-sites. `resolving` guards against a crafted SVG-to-SVG
 * reference cycle recursing forever.
 */
function makeImageResolution(
  entries: Map<string, Uint8Array>,
  manifest: Map<string, EpubManifestItem>,
): ImageResolution {
  const mediaTypeByPath = new Map<string, string>();
  for (const item of manifest.values()) {
    mediaTypeByPath.set(item.absolutePath, item.mediaType);
  }
  const cache = new Map<string, string | undefined>();
  const resolving = new Set<string>();
  let count = 0;

  function resolveAbsolute(absPath: string): string | undefined {
    if (cache.has(absPath)) {
      return cache.get(absPath);
    }
    if (resolving.has(absPath)) {
      return undefined; // reference cycle — fail safe rather than recurse forever
    }
    resolving.add(absPath);
    let result: string | undefined;
    try {
      const bytes = entries.get(absPath);
      const mediaType = mediaTypeByPath.get(absPath);
      if (bytes === undefined || mediaType === undefined || !ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) {
        result = undefined;
      } else if (mediaType === "image/svg+xml") {
        const svgText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
        const sanitized = sanitizeSvgMarkup(svgText, (href) => resolveAbsoluteFromReference(href, absPath));
        result = sanitized === undefined ? undefined : svgMarkupToDataUrl(sanitized);
      } else {
        result = rasterImageDataUrl(bytes, mediaType);
      }
    } finally {
      resolving.delete(absPath);
    }
    cache.set(absPath, result);
    if (result !== undefined) {
      count++;
    }
    return result;
  }

  function resolveAbsoluteFromReference(rawHref: string, basePath: string): string | undefined {
    if (hasDisallowedUrlScheme(rawHref)) {
      return undefined;
    }
    const withoutFragment = (rawHref.split(/[?#]/)[0] ?? "").trim();
    if (withoutFragment.length === 0) {
      return undefined;
    }
    let absPath: string;
    try {
      absPath = resolveEpubRelativePath(basePath, withoutFragment);
    } catch {
      return undefined;
    }
    return resolveAbsolute(absPath);
  }

  const resolveRelative: ImageResolver = (rawSrc, chapterPath) =>
    resolveAbsoluteFromReference(rawSrc, chapterPath);

  return { resolveRelative, resolveAbsolute, imageCount: () => count };
}

// --- CSS collection --------------------------------------------------------

function findManifestItemByPath(
  manifest: Map<string, EpubManifestItem>,
  absPath: string,
): EpubManifestItem | undefined {
  for (const item of manifest.values()) {
    if (item.absolutePath === absPath) {
      return item;
    }
  }
  return undefined;
}

// --- layout detection --------------------------------------------------------

/** Re-reads the raw OPF for `<spine page-progression-direction="...">` (spec §12's #2 signal) — not exposed by opf.ts's EpubPackageDocument, so this uses the same shared xml.ts helpers Phase 2 uses rather than extending Phase 2's parser. */
function readPageProgressionDirection(
  entries: Map<string, Uint8Array>,
  opfPath: string,
): "ltr" | "rtl" | undefined {
  const bytes = entries.get(opfPath);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const xml = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
    const doc = parseXmlDocument(xml);
    if (doc.documentElement === null) {
      return undefined;
    }
    const spineEl = firstByLocalName(doc.documentElement, "spine");
    const value = spineEl?.getAttribute("page-progression-direction");
    return value === "rtl" || value === "ltr" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spec §12: layout="auto" resolution order — explicit
 * page-progression-direction+Japanese language, then a vertical-rl
 * writing-mode already present in the EPUB's own CSS, else horizontal.
 * "日本語だから自動的に縦書きにはしない" — dc:language alone is never
 * sufficient.
 *
 * `cssTexts` is comment-stripped (css.ts's stripComments) but NOT run
 * through sanitizeCss's property allowlist — not the sanitized copy that
 * ends up in the generated document. sanitizeCss now drops `writing-mode`
 * outright (css.ts's ALLOWED_PROPERTIES doc comment), so scanning the
 * sanitized text would blind this exact signal; comments are still
 * stripped so a commented-out `writing-mode: vertical-rl` can't produce a
 * false-positive "vertical" detection (see stripComments's own doc comment
 * for what this does and doesn't cover — `@supports` conditions are an
 * accepted gap).
 */
function detectLayout(
  pkg: EpubPackageDocument,
  entries: Map<string, Uint8Array>,
  cssTexts: string[],
  userLayout: EpubConvertOptions["layout"],
): "horizontal" | "vertical" {
  if (userLayout !== "auto") {
    return userLayout;
  }
  const ppd = readPageProgressionDirection(entries, pkg.opfPath);
  const isJapanese = (pkg.metadata.language ?? "").toLowerCase().startsWith("ja");
  if (ppd === "rtl" && isJapanese) {
    return "vertical";
  }
  if (cssTexts.some((css) => /writing-mode\s*:\s*vertical-rl/i.test(css))) {
    return "vertical";
  }
  return "horizontal";
}

// --- nav / TOC / cover -------------------------------------------------------

function findChapterTitle(nav: EpubNavigation, path: string): string | undefined {
  for (const entry of nav.entries) {
    const hashIdx = entry.href.indexOf("#");
    const pathPart = hashIdx === -1 ? entry.href : entry.href.slice(0, hashIdx);
    if (pathPart === path) {
      return entry.label;
    }
  }
  return undefined;
}

/**
 * One candidate XTC chapter, built from a single top-level TOC entry before
 * this spine item's actual sanitization runs — "candidate" because the
 * chapter only survives into prepareEpubDocument's final `chapters` if its
 * target spine item ends up rendered AND (for a fragment entry) its id is
 * actually found there; see the caller's failedSpineIndexes /
 * unresolvedFragmentsByIndex bookkeeping.
 */
interface XtcChapterCandidate {
  chapter: XtcChapter;
  /** This candidate's target spine index (renderedSpine's own indexing, matching spineIndexByPath/chapterSectionId). */
  targetIndex: number;
  /** "" for a fragment-less TOC entry (targets the whole spine item); otherwise the raw (pre-namespacing) id from the entry's "#fragment". */
  fragment: string;
}

/**
 * Builds the XTC chapter candidate list and, grouped by target spine index,
 * the ChapterMarkerPlan sanitizeSpineChapter needs to actually embed each
 * candidate's marker — from ONLY this nav's top-level entries (decision:
 * nested TOC entries never become chapters — the XTC device's chapter menu
 * is a flat list on real hardware, and following every nesting level would
 * both make that flat list impractical to navigate and risk silently
 * truncating a large book's later chapters against container.ts's
 * MAX_XTC_CHAPTERS=200 cap). A TOC with no top-level entries at all (no
 * `<nav>`/NCX found, or every entry nested) simply yields no candidates —
 * this feature has no heading-tag-based fallback, unlike the
 * TXT/Aozora-URL pipelines' own chapter extraction.
 *
 * Markers are numbered sequentially over ACCEPTED candidates only (an entry
 * with an unresolvable TOC target, or one whose normalized label is empty —
 * matching src/aozora.ts's own "empty name -> not a chapter" rule — never
 * consumes a marker number). Numbering gaps from a candidate later dropped
 * for a different reason (its target spine item fails to render, or its
 * fragment id is never found — both discovered only once the caller
 * actually sanitizes that spine item) are harmless: the Container matches
 * chapters to pages by searching the PDF's text layer for each marker
 * STRING, never by the numeric sequence itself.
 */
function buildXtcChapterPlan(
  nav: EpubNavigation,
  spineIndexByPath: ReadonlyMap<string, number>,
): { candidates: XtcChapterCandidate[]; markerPlanByIndex: Map<number, ChapterMarkerPlan>; unresolvedTocTargetCount: number } {
  const candidates: XtcChapterCandidate[] = [];
  const markerPlanByIndex = new Map<number, ChapterMarkerPlan>();
  let unresolvedTocTargetCount = 0;

  for (const entry of nav.entries) {
    if (!entry.isTopLevel) {
      continue;
    }
    const hashIdx = entry.href.indexOf("#");
    const pathPart = hashIdx === -1 ? entry.href : entry.href.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? "" : entry.href.slice(hashIdx + 1);
    const targetIndex = spineIndexByPath.get(pathPart);
    if (targetIndex === undefined) {
      // Points outside the rendered spine (excluded/non-linear item, the
      // TOC's own nav.xhtml, or a broken href) — same "can't link to it"
      // situation buildTocSection's identical lookup already handles by
      // falling back to a plain <li>; here there is no marker to embed at
      // all, so the candidate is dropped outright rather than partially
      // included.
      unresolvedTocTargetCount++;
      continue;
    }
    const name = normalizeChapterName(entry.label);
    if (name.length === 0) {
      continue;
    }
    const marker = formatChapterMarker(candidates.length + 1);
    candidates.push({ chapter: { name, marker }, targetIndex, fragment });

    const plan = markerPlanByIndex.get(targetIndex) ?? { byId: new Map<string, string[]>(), atStart: [] };
    if (fragment.length === 0) {
      plan.atStart.push(marker);
    } else {
      const existing = plan.byId.get(fragment) ?? [];
      existing.push(marker);
      plan.byId.set(fragment, existing);
    }
    markerPlanByIndex.set(targetIndex, plan);
  }

  return { candidates, markerPlanByIndex, unresolvedTocTargetCount };
}

function buildTocSection(nav: EpubNavigation, spineIndexByPath: ReadonlyMap<string, number>): string | undefined {
  if (nav.entries.length === 0) {
    return undefined;
  }
  const items = nav.entries.map((entry) => {
    const hashIdx = entry.href.indexOf("#");
    const pathPart = hashIdx === -1 ? entry.href : entry.href.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? "" : entry.href.slice(hashIdx + 1);
    const label = escapeHtml(entry.label);
    const targetIndex = spineIndexByPath.get(pathPart);
    if (targetIndex === undefined) {
      return `<li>${label}</li>`;
    }
    const anchor = fragment.length === 0 ? chapterSectionId(targetIndex) : namespacedId(targetIndex, fragment);
    return `<li><a href="#${anchor}">${label}</a></li>`;
  });
  if (items.every((item) => !item.includes("<a "))) {
    return undefined; // nothing resolvable — an all-text list is not a useful TOC
  }
  return `<nav class="epub-generated-toc" aria-label="Table of Contents">\n<h2>目次</h2>\n<ol>\n${items.join("\n")}\n</ol>\n</nav>`;
}

function buildCoverSection(coverDataUrl: string): string {
  return `<section class="epub-cover"><img src="${coverDataUrl}" alt=""></section>`;
}

/**
 * Detects a spine item that is, in effect, a second copy of the cover
 * already emitted as the standalone `.epub-cover` section — the "cover
 * page" convention many EPUBs (青空文庫-derived ones especially) use:
 * spine[0] is a dedicated XHTML file containing nothing but the same image
 * the OPF's `cover-image` manifest property points at. Deliberately
 * conservative: only true when the sanitized body has NO non-whitespace
 * text at all AND every image it contains resolves to the exact same data:
 * URL as the cover — a spine item with its own text (even a caption) or a
 * DIFFERENT image is always kept, so a real chapter is never at risk of
 * being dropped by this check. Not restricted to spine[0]: a book that also
 * repeats the cover as a colophon-adjacent "back cover" page gets the same
 * treatment.
 */
function isCoverDuplicateSpineItem(sanitized: SanitizedChapter, coverDataUrl: string): boolean {
  if (sanitized.textContent.replace(/\s+/g, "").length > 0) {
    return false;
  }
  return sanitized.imageDataUrls.length > 0 && sanitized.imageDataUrls.every((src) => src === coverDataUrl);
}

// --- final device-geometry correction CSS ------------------------------------

/**
 * Spec §13.1/§13.2/§12.1: the target device's page geometry (528x792 for
 * X3, 480x800 for X4 — resolveDeviceProfile(options.device), src/devices.ts;
 * dynamic, not a fixed literal, despite the spec being written against the
 * X3-only baseline), the chosen font
 * forced over the EPUB's own (both `@font-face` data AND `font`/
 * `font-family` CSS declarations were already stripped from every
 * EPUB-supplied CSS surface — D3/D12, css.ts's ALLOWED_PROPERTIES — and the
 * `font-family`/`font` presentation attributes that would otherwise bypass
 * that allowlist entirely (`<font face>`, SVG's `font-family`/`font`) are
 * stripped too, sanitize.ts's attribute pass, so there is no author
 * font-family declaration or presentation attribute, among the surfaces
 * closed so far, left to lose to — see css.ts's ALLOWED_PROPERTIES doc
 * comment for why "closed so far" rather than "all of them"), the
 * image-sizing rules (§11.2), and the optional chapter-page-break
 * rule (§9.2). Explicit (non-"auto") layout choices win over the EPUB's own
 * CSS via `!important`; "auto" only supplements it.
 *
 * Margin: applied via `@page { margin }`, not `.epub-book { padding }`. In
 * `writing-mode: vertical-rl`, the block direction runs right-to-left, and
 * block-direction padding on an element that gets fragmented across pages
 * (spec's whole multi-page book) only lands on the FIRST and LAST page's
 * fragment, not on every page — so a left/right (== block-direction, in
 * vertical writing) padding on `.epub-book` left every interior page with
 * ~0 left/right margin (real-world repro: 熊野奈智山.epub). `@page`'s
 * margin is a per-page box property instead, so it applies uniformly no
 * matter how the content fragments — this is exactly what src/text-html.ts
 * already relies on (buildTextPrintCss) for the same per-device page size.
 * Matching that file, `html`/`body` no longer hard-code `width`/`min-height`: the
 * printable content box is already defined by `@page`'s size minus its
 * margin, so a second, redundant fixed-size box on the root would only
 * fight it (and, at non-default marginPx values, contradict it outright).
 *
 * writing-mode placement: `html` for vertical, `.epub-book` for horizontal
 * — and, crucially, this is now the ONLY place `writing-mode` is declared
 * in the whole generated document, because css.ts's ALLOWED_PROPERTIES
 * drops `writing-mode` from every bit of EPUB-supplied CSS before it
 * reaches this document (stylesheets, inline `<style>`, inline
 * `style=""`). That single-sourcing is what actually fixes the demonstrated
 * bug: CSS cascades per element, so an EPUB's own `body { writing-mode: ... }`
 * (common in 青空文庫-derived books) otherwise wins over whatever this
 * function puts on `html`/`.epub-book` regardless of `!important`, which
 * silently defeated an explicit (non-"auto") `layout` choice whenever the
 * source EPUB disagreed with it. With the EPUB's own writing-mode gone,
 * that can no longer happen.
 *
 * Root-vs-descendant placement (`html` only for vertical, not `body` too)
 * is a separate, PRECAUTIONARY choice, not a fix for an observed bug: it
 * mirrors src/text-html.ts's own placement, whose doc comment describes a
 * real, reproduced Chromium print-pagination failure (nested
 * `writing-mode: vertical-rl` on a descendant blanking every page after the
 * first) for a *different* configuration — one where the root has NO
 * writing-mode and only a nested element does. This function's old code
 * (both `html` AND `body` set to the same value) was never observed to
 * blank pages in production, so "root + duplicate nested value" is not
 * confirmed to share that failure mode. It's still avoided here on the
 * grounds that untested is not the same as safe, but that's the extent of
 * the claim.
 */
function buildFinalCss(
  options: EpubConvertOptions,
  layout: "horizontal" | "vertical",
  layoutIsExplicit: boolean,
  hasXtcChapters: boolean,
): string {
  const important = layoutIsExplicit ? " !important" : "";
  const genericFamily = layout === "vertical" ? "serif" : "sans-serif";
  const pageBreakRule = options.chapterPageBreak
    ? `.epub-spine-item + .epub-spine-item {\n  break-before: page;\n  page-break-before: always;\n}\n`
    : "";
  // XTC chapter markers (sanitize.ts's insertChapterMarkerSpans): unlike
  // packages/aozora-text's own XTC_CHAPTER_MARKER_CSS (used verbatim by the
  // TXT/Aozora-URL pipelines, which never share a document with arbitrary
  // author CSS), an EPUB's own stylesheet IS arbitrary author CSS that
  // sanitizeCss (css.ts) lets right through for `color`/`font-size` — a
  // broad rule like `span { font-size: 1.2em !important }` could otherwise
  // make a marker visible/selectable/announced. This block re-declares the
  // same properties, scoped to the marker's own class (already more
  // specific than a bare tag selector) AND with `!important` unconditionally
  // (unlike this function's layout-related rules above, which only add
  // `!important` when layoutIsExplicit) — same "never something to defer to"
  // stance as the img/svg `float: none !important` rule above, because an
  // EPUB author had no way to know this class even existed, so there is no
  // legitimate authored intent to respect here. Gated on hasXtcChapters
  // purely to skip emitting dead CSS for a book with no usable TOC (no
  // marker spans exist in `html` at all in that case).
  //
  // NOT a currently-live defense: sanitize.ts's insertChapterMarkerSpans
  // always sets the same properties as an inline `style=""` attribute on
  // every marker span (XTC_CHAPTER_MARKER_INLINE_STYLE), and an inline style
  // attribute's declarations always win the cascade over ANY selector-based
  // declaration at the same importance level regardless of specificity (CSS
  // Cascading Level 4 §5.1) — so THIS class rule can never actually be the
  // one that wins against a hostile EPUB stylesheet today; it is a second,
  // currently-redundant layer that only matters if a future refactor ever
  // removes the inline style and relies on this rule alone. Precisely
  // BECAUSE it is meant to survive unnoticed as backup for years, its own
  // values must independently be correct — see the next paragraph.
  //
  // `color: white` + `-webkit-text-fill-color: white` (never `transparent`)
  // for the same production-measured reason as packages/aozora-text's
  // XTC_CHAPTER_MARKER_CSS and this module's own XTC_CHAPTER_MARKER_INLINE_STYLE
  // (sanitize.ts): Cloudflare Browser Rendering — the actual renderer behind
  // renderSelfStyledHtmlPdf, which every EPUB conversion goes through — drops
  // alpha=0 text (`color: transparent`) from the PDF text layer entirely,
  // unlike a local Chrome. See XTC_CHAPTER_MARKER_CSS's "WHY WHITE, NOT
  // TRANSPARENT" doc comment (packages/aozora-text/src/chapters.ts) for the
  // full A/B evidence and for why `white`, specifically, is what an opaque
  // color should be here. Both `color` and `-webkit-text-fill-color` are set
  // because either one alone can be repainted by a hostile author rule that
  // only targets the other. This rule was ALSO left at `color: transparent`
  // (no `-webkit-text-fill-color`) until a review caught it as the one of
  // three marker-hiding declarations in this codebase that was never updated
  // when the other two (XTC_CHAPTER_MARKER_CSS, XTC_CHAPTER_MARKER_INLINE_STYLE)
  // were fixed — its dead-today status is exactly why it was easy to miss,
  // and exactly why test/epub/html.test.ts pins its actual color value
  // rather than only the selector's presence.
  //
  // `position: absolute` — kept in sync with XTC_CHAPTER_MARKER_INLINE_STYLE
  // (sanitize.ts) for the same layout bug that constant's own doc comment
  // documents in full (including exactly which element the marker ends up a
  // sibling of, and why — do not re-derive that here, read it there): an
  // `atStart` marker ends up a PRECEDING SIBLING of the chapter's own
  // top-level element inside the `epub-spine-item` section this function
  // builds below, not a child of it or of the heading, so as an ordinary
  // in-flow inline element it gets wrapped in an anonymous block box whose
  // line box inherits the EPUB's own (arbitrary) `line-height` — reproduced
  // as roughly one extra column's worth
  // (~48-57px at fontSizePx:30/line-height:1.9) of block-direction blank
  // space on the chapter's own first page of a real vertical-writing EPUB
  // (a SEPARATE, much larger, marker-independent pagination defect was also
  // found on that same book's later pages during this investigation — see
  // XTC_CHAPTER_MARKER_INLINE_STYLE's doc comment and the task report for
  // why this fix does not, by itself, resolve that one). `position:
  // absolute` removes it from box generation entirely. Deliberately DIVERGES
  // from
  // packages/aozora-text's XTC_CHAPTER_MARKER_CSS, which explicitly rejects
  // `position: absolute` — that rejection is still correct there (aozora's
  // marker is always the heading's own first child, sharing its line box
  // under aozora's own fixed, non-arbitrary CSS, so the anonymous-block
  // strut this fix targets never applies) and must not be copied over
  // blindly; see XTC_CHAPTER_MARKER_INLINE_STYLE's doc comment for the full
  // reasoning and the empirical page-association check (PyMuPDF, matching
  // converter/app.py's own extraction method) that cleared this choice.
  const xtcChapterMarkerRule = hasXtcChapters
    ? `.${XTC_CHAPTER_MARKER_CLASS} {
  color: white !important;
  -webkit-text-fill-color: white !important;
  font-size: 1px !important;
  position: absolute !important;
  user-select: none !important;
  -webkit-user-select: none !important;
}
`
    : "";
  const writingModeRule =
    layout === "vertical"
      ? `html {
  writing-mode: vertical-rl${important};
  text-orientation: mixed${important};
}
`
      : `.epub-book {
  writing-mode: horizontal-tb${important};
  text-orientation: mixed${important};
}
`;
  // Page content box (page size minus the @page margin on every side) —
  // named for what it is, not for who first needed it: originally computed
  // only for .epub-cover (see that rule's own doc comment below for why a
  // definite box matters there), but the same number is now also the img/svg
  // rule's max-width/max-height ceiling below, for the identical reason. Both
  // dimensions are needed, not just height — again, see .epub-cover's doc
  // comment for why.
  const device = resolveDeviceProfile(options.device);
  const pageContentWidthPx = Math.max(0, device.outputWidthPx - options.marginPx * 2);
  const pageContentHeightPx = Math.max(0, device.outputHeightPx - options.marginPx * 2);
  return `@page {
  size: ${device.outputWidthPx}px ${device.outputHeightPx}px;
  margin: ${options.marginPx}px;
}

html, body {
  margin: 0;
  padding: 0;
  background: #fff;
  color: #000;
}

*, .epub-book * {
  /* Emergency line breaking for unbreakable tokens. A single token longer
     than the column extent — real repro: a 54-char URL in body text, which
     at fontSizePx 30 exceeds the X3 page's 712px column in vertical-rl
     writing mode — does not merely overflow its own line: it
     broke pagination for the WHOLE document, with roughly a third of the
     body text emitted on no page at all and every page's margins collapsed
     (measured: 348 of the real book's 1092 pages — 32% — never rendered,
     and on the minimal repro 2 of 5 pages — 40%: 3 pages with the ink
     pushed into the page margin vs 5 pages with normal margins once
     wrapping was enabled, the 2 extra pages being the text that had
     silently vanished). The
     TXT/Aozora pipeline (src/text-html.ts) has always declared
     "overflow-wrap: anywhere" on its .content; this EPUB path had no wrap
     declaration at all, and that one difference was the whole bug.

     "anywhere", NOT "break-word": both add the same emergency break
     opportunities in normal flow (measured identical on the plain-
     paragraph repro), but break-word does not let those breaks into
     min-content intrinsic-size calculation, so a long token inside a
     table cell (or any other min-content-sized context) keeps its full
     unbroken length as the cell's minimum size and reproduces this exact
     text-loss failure — measured: the same repro with the URL moved into
     a <td> stayed broken under break-word (identical page count and
     edge-pinned ink as with no declaration at all) and was fixed by
     anywhere. "anywhere" is also what src/text-html.ts already uses.

     Universal selector, NOT an inherited html/body declaration:
     overflow-wrap deliberately stays on css.ts's ALLOWED_PROPERTIES (an
     author's own wrap declarations are usually harmless or helpful, so
     they are preserved), which means an EPUB rule that declares, say,
     "overflow-wrap: normal" directly on p sits on the element and beats
     an inherited value regardless of any !important on the ancestor —
     the same per-element cascade mechanism css.ts's writing-mode doc
     comment documents. The universal selector puts the declaration
     directly on every element, so there is no inherited value to lose.

     Selector scope — a two-part list, the bare universal selector PLUS
     .epub-book with a universal descendant: specificity is taken per
     complex selector, so an element inside the epub-book main matches
     the 0,1,0 variant, which beats an author's element-only !important
     rule (0,0,1 for p, 0,0,2 for div p, ...) inside the important tier —
     the one fight the bare universal selector (0,0,0) always loses. All
     chapter content — everything EPUB author CSS can actually target
     with rules written for the book's own markup — lives inside that
     main (see the document assembly in prepareEpubDocument), so the
     higher-specificity variant covers every element where a competing
     author declaration is realistic. The bare universal variant is kept
     alongside it for the generated sections OUTSIDE the main
     (.epub-cover, and .epub-generated-toc — whose text is author-derived
     nav labels and can carry the same over-long tokens), which it
     protects against every non-important declaration. Pure cascade
     arithmetic, not a rendering change: wherever both variants apply the
     computed value is identical.

     Unconditional !important — same stance as the img/svg
     float:none/max-width rules below: an unbreakable token that destroys
     pagination is a text-legibility (here: text-EXISTENCE) failure this
     converter must always prevent, never an authored presentation choice
     for an "auto" layout to defer to. With it, this rule beats every
     non-!important author declaration outright (the importance tier
     outranks specificity). Residual gaps, accepted and NOT fixed here
     (same shape as the img rule's own residual-gap paragraph): (1) an
     author declaration that is ITSELF !important (css.ts keeps authored
     !important verbatim) wins within the important tier once its
     specificity exceeds 0,1,0 — class-plus-element, two classes, any id,
     ... — while an exact 0,1,0 tie falls to source order, which this
     stylesheet wins by coming last. That 0,1,0 threshold holds inside
     the epub-book main only: for the generated sections outside it, only
     the bare 0,0,0 variant applies, so there any author !important at
     0,0,1 or above wins; (2) white-space values that disable
     wrapping make overflow-wrap inert wherever they apply — the one
     UA-DEFAULT surface with such a value, pre, is closed by the
     dedicated pre rule below, but an author "white-space: nowrap" (an
     allowed property) on any other element remains open.

     Japanese typography is untouched: overflow-wrap adds EMERGENCY break
     points only, considered when a line has no otherwise-acceptable
     break point — ordinary Japanese text has break opportunities between
     virtually every character, so normal lines never reach them.
     Measured pixel-identical with/without this rule on a vertical sample
     exercising 縦中横 (text-combine-upright), ruby/rt, line-break:strict,
     and kinsoku-relevant punctuation. */
  overflow-wrap: anywhere !important;
}

${writingModeRule}
html, body, .epub-book {
  font-family: "${options.font}", ${genericFamily}${important};
  font-size: ${options.fontSizePx}px;
}

pre, code, kbd, samp {
  font-family: monospace${important};
}

pre {
  /* The UA stylesheet gives pre "white-space: pre", which disables line
     wrapping entirely — and where wrapping is disabled, the
     overflow-wrap rule above is inert. So a single pre line longer than
     the column (a long URL or identifier in a tech book's code block)
     reproduces the exact pagination destruction that rule exists to
     prevent, with NO author CSS involved at all. Measured on the minimal
     repro: the skeleton renders 4 normal pages; adding one pre with one
     over-long line collapsed it to 2 pages with the surrounding prose
     gone and the ink pushed to the page edge; with this rule it renders
     5 normal pages with nothing lost. pre-wrap preserves the author's
     newlines and interior spaces exactly — a line that fits renders
     identically to white-space: pre — and only adds soft wrap
     opportunities, which the emergency breaking above then uses for
     over-long tokens. The accepted trade-off (same text-first stance as
     everything else in this stylesheet): a wrapped code line loses its
     column alignment from the wrap point on, but misaligned code is
     still readable while text that appears on no page is not. Scoped to
     pre alone, NOT the font-family rule's pre/code/kbd/samp group:
     code/kbd/samp default to white-space normal (nothing to fix there),
     and forcing pre-wrap on them would newly preserve interior space
     runs that an EPUB's inline code spans currently render collapsed.
     !important because white-space is on css.ts's ALLOWED_PROPERTIES, so
     a plain declaration here would lose to any author reset that
     re-declares white-space: pre on pre; with it, an author's own
     !important on the same bare pre selector still loses on source order
     (this stylesheet comes last), leaving only higher-specificity author
     !important rules as the residual — the same accepted shape as the
     overflow-wrap rule's residual gap (1) above. */
  white-space: pre-wrap !important;
}

img, svg {
  /* PX, not the more obvious percentage form (max-width/max-height at 100%)
     — same underlying CSS rule .epub-cover's own doc comment below
     documents (percentage sizes only resolve against a containing block
     that is definite in that axis), but hitting a DIFFERENT element here:
     .epub-cover's box is a purpose-built div this function itself sizes
     explicitly, so it was easy to make definite; an in-chapter <img>'s
     containing block is whatever ordinary flow element the EPUB's own
     markup put it in, and in vertical-writing-mode body text that
     ancestor's inline size (the img's block-direction max, since size
     keywords are physical, not logical, on max-width/max-height) is not
     reliably definite the way a dedicated cover box is — so a max-width of
     100% there regularly computed to "none" and the <img> rendered at its
     raw intrinsic size instead of being clamped to the page.
     pageContentWidthPx/pageContentHeightPx are always definite numbers
     (computed above from @page's own size and margin), so using them here
     removes the "is the containing block definite?" question entirely
     rather than depending on how any given EPUB happens to markup its
     image's ancestors.

     !important — unconditionally, like this rule's existing float:none
     !important below, NOT gated on layoutIsExplicit the way this
     function's other rules are: found necessary, not just defensive,
     against a real EPUB whose own stylesheet declares a max-width of 100%
     and a height of auto, scoped to a class-plus-tag selector matching this
     exact figure's img (one class, two types — figure AND img — so
     specificity 0,1,2). That beats this bare "img, svg" rule's specificity
     of 0,0,1 regardless of which one appears later in the document, so
     without !important the EPUB's own percentage rule won the cascade
     outright and reproduced the exact same "renders at intrinsic size,
     clipped at the page edge" failure this rule exists to prevent — this
     was not a hypothetical, it is what actually happened first, on the
     SAME empirical repro this doc comment cites below, before !important
     was added. The float rule's own doc comment already establishes the
     standing rule this codebase applies to img/svg sizing/behavior
     corrections: never something an "honor the EPUB's own presentation"
     auto choice should defer to, because the alternative is a text- or
     content-legibility regression this converter must always prevent. A
     clipped, silently-truncated illustration is that same failure mode, so
     the same unconditional !important applies here too.

     Trade-off this !important accepts (reasoned from the CSS cascade
     rules, NOT separately reproduced against a real EPUB the way the
     clipping bug above was): before this rule had !important, an EPUB's
     OWN higher-specificity max-width could still legitimately win in two
     cases this codebase used to get right — (1) an author who deliberately
     shrinks an image below page size, e.g. a thumbnail rule scoped to a
     class (specificity higher than this bare tag-selector rule) setting
     max-width to a small px value, used to win via specificity, and now
     always gets overridden by this rule's page-content-box ceiling instead
     (harmless when the ceiling is larger than the author's own value, but
     it does mean the author's specific choice no longer reaches the
     renderer at all); (2) an image whose containing block WAS definite
     (e.g. an ancestor with an explicit width), where the old
     max-width of 100% correctly resolved against that ancestor's box — this
     rule's fixed page-content-box px value has no notion of that ancestor
     and could in principle now size the image past it. Accepting this was
     a deliberate choice: silently losing page content (this fix's target
     bug) is worse than silently ignoring an author's own size constraint,
     and of the two, only the former was ever observed to actually destroy
     reader-visible information. Not fixed here: making the !important
     conditional on "does the EPUB have a competing, more specific rule"
     would require re-deriving CSS specificity for arbitrary EPUB-authored
     selectors in this function, which this codebase has no mechanism for
     and is out of scope for this fix.

     Residual gap even with this !important: css.ts's sanitizeDeclaration
     keeps whatever !important flag an EPUB's own declaration already had
     (see that file's own doc comments — parseDeclarations does not strip
     it, and no later pass does either); it is only THIS class of hostile
     rule that xtcChapterMarkerRule's doc comment above treats as a known,
     already-handled threat for the chapter-marker spans specifically. For
     ordinary img/svg sizing, that threat is NOT separately neutralized: if
     an EPUB's own rule were ALSO marked !important (this book's
     figure.h-figure img rule, empirically, is not), the cascade would
     compare specificity within the "important" bucket the same way it does
     for normal declarations, and the EPUB's 0,1,2 would still beat this
     rule's 0,0,1 — reproducing this exact bug again. Stripping !important
     from EPUB-authored CSS globally would close this, but that is a
     broader change to css.ts's sanitizer than this fix's scope, and is
     intentionally not made here.

     Empirically reproduced end-to-end against a real EPUB (X3 device,
     marginPx 40 -> 448x712px page content box): with only the percentage
     rule (no !important, pre-dating this fix), a 752x465 in-chapter image
     rendered at full intrinsic size, overflowed the page, and was silently
     clipped at the page boundary in the actual PDF — not merely pushed to
     the next page, GONE (the clipped-off portion, a chart's rightmost data
     column and the table beneath it, appeared on no page at all). Six of
     seven in-chapter images in that same book exceeded 448px in the block
     direction, so this was not a rare edge case for that book. */
  max-width: ${pageContentWidthPx}px !important;
  max-height: ${pageContentHeightPx}px !important;
  object-fit: contain;
  break-inside: avoid;
  /* Unconditional !important, unlike this function's other rules (which
     only add !important when layoutIsExplicit): float:left/right on img is
     never something a "keep the EPUB's own presentation" auto choice
     should honor — it makes body text wrap into the image's margin instead
     of flowing normally, which is a text-legibility regression this
     converter must always prevent (per this repo's text-first CSS
     stance), not a layout preference to defer to. Deliberately NOT paired
     with a global zeroed-out margin here (see .epub-cover img below for why a
     margin reset is still needed, just scoped): a body illustration's own
     margin is cosmetic, not the text-wrap hazard float is, so leaving it
     alone avoids gratuitously flattening every in-chapter image against
     its surrounding paragraph. */
  float: none !important;
}

figure {
  break-inside: avoid;
}

.epub-cover {
  /* Both width and height must be explicit (not e.g. min-height alone). This
     was originally required because the <img> inside relied on
     max-width/max-height:100%, which only resolves against a containing
     block whose size in that axis is definite — CSS spec's rule for
     percentage sizes, not this codebase's assumption. With only min-height
     set (the prior version of this rule), the box's HEIGHT still counted as
     indefinite for that purpose, so max-height:100% computed to "none" and
     the <img> rendered at its raw intrinsic pixel size instead. Empirically
     reproduced against 熊野奈智山.epub's real 600x800 cover in an actual
     Chromium print render: the oversized image fragment spilled onto page
     2, which pushed .epub-cover's content off page 1 entirely and left it
     fully blank. width has the same requirement even though it was never
     observed failing on its own here (a definite height alone happened to
     be enough for this specific nearly-page-sized image) — giving both is
     the actually-correct fix, not a guess. The global img/svg rule above
     has since moved off percentages onto its own explicit
     pageContentWidthPx/pageContentHeightPx ceiling (same underlying bug,
     found again for in-chapter images — see that rule's doc comment), so
     this box's width/height are no longer load-bearing for THAT
     percentage-resolution reason; they are kept because this box still
     needs its own definite size for the flex-centering below and for
     overflow:hidden's backstop role. overflow:hidden is a backstop only,
     not the fix itself: with both dimensions definite, the img rule's
     max-width/max-height plus object-fit:contain (above) already guarantee
     the whole image fits and is never cropped — overflow:hidden just
     guarantees a future regression clips invisibly instead of silently
     pushing content onto the next page's fragment the way this bug did. */
  width: ${pageContentWidthPx}px;
  height: ${pageContentHeightPx}px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  break-after: page;
  page-break-after: always;
}

.epub-cover img, .epub-cover svg {
  /* Scoped, not global (unlike float above): re-tested after the
     width/height fix above — with both dimensions definite the overflow
     bug is already fully fixed without this, so this rule exists purely
     for centering polish (熊野奈智山.epub's own img rule sets an
     asymmetric margin: 15px, 0 on the left, which would otherwise nudge
     the cover image slightly off-center within the frame). Kept off the
     global img/svg rule so an EPUB-authored margin around an in-chapter
     illustration is left alone. */
  margin: 0 !important;
}

${pageBreakRule}
${xtcChapterMarkerRule}`;
}

// --- entrypoint --------------------------------------------------------------

/**
 * Parses `bytes` as an EPUB and produces a self-contained X3-ready HTML
 * document (spec §8-§13). The sole entrypoint Phase 4's Workflow calls.
 *
 * Throws EpubError for every unrecoverable condition (malformed archive,
 * missing/invalid container or package, fixed layout, empty spine, oversized
 * HTML — `.deterministic` tells the caller these are never worth retrying,
 * per errors.ts's doc comment). A per-chapter failure (unparseable XHTML,
 * missing spine-item bytes) does NOT abort the job — spec's general
 * fail-soft stance — it is recorded in `warnings` and the chapter is
 * skipped; EMPTY_SPINE is only thrown if EVERY chapter failed this way.
 *
 * Font handling (design decision D12): the returned `html` never contains
 * `@font-face` data (EPUB's own were already dropped — D3) and never
 * fetches a web font itself. It also never contains an EPUB-authored
 * `font`/`font-family` declaration or presentation attribute, on every
 * surface found and closed so far: stylesheets, inline `<style>`, inline
 * `style=""`, `<font face="...">`, and SVG's `font-family`/`font`
 * presentation attributes are all stripped — css.ts's ALLOWED_PROPERTIES
 * and sanitize.ts's attribute pass — so the only `font-family` declarations
 * anywhere in the document are the ones this function's own `<style>`
 * emits: the user's chosen family BY NAME on `html, body, .epub-book`, plus
 * generic `monospace` for `pre, code, kbd, samp`. That attribute-level
 * removal is a denylist, not an allowlist like the CSS side, so unlike the
 * CSS half of this guarantee it is not structurally exhaustive against a
 * font-family-carrying attribute EPUB authoring tools haven't used yet —
 * see css.ts's ALLOWED_PROPERTIES doc comment and sanitize.ts's own
 * attribute-pass comments for the current, non-final list. Phase 4 is
 * responsible for calling
 * buildInlineFontCss(preparedDoc.html, jobId, fetch, options.font) — passing
 * the whole generated HTML as the subset-text source is intentional and
 * matches src/fonts.ts's own "over-inclusion is harmless" stance (the extra
 * ASCII from markup/CSS costs a negligible slice of the subsetter's
 * character budget) — and injecting the resulting fontCss into
 * renderSelfStyledHtmlPdf's `addStyleTag`, exactly like src/workflow.ts's
 * existing prepare-text/render-text-pdf step pair. This mirrors the TXT
 * pipeline instead of inlining a second, EPUB-specific font-fetch path.
 *
 * XSS/breakout defense (spec D10's pointer to src/printhtml.ts's
 * <title>/<style> verbatim-serialization hazard): the document below is
 * assembled via escapeHtml'd template-string concatenation, NOT
 * document.toString() on a linkedom tree — so there is no verbatim-child
 * special case to guard against for <title> at all (its text always goes
 * through escapeHtml). The generated `<style>` blocks are CSS text that
 * MUST stay unescaped to remain valid CSS, so those instead go through
 * styleSafe() (breaks any literal "</style" sequence). Chapter body HTML
 * fragments (sanitize.ts's output) are the one piece embedded raw
 * un-touched — safe because sanitizeSpineChapter's STRIP_SELECTOR removes
 * every <style>/<title> element from chapter bodies before serialization,
 * so linkedom's own innerHTML serializer never hits its verbatim-child case
 * for anything this function embeds.
 */
export function prepareEpubDocument(
  bytes: Uint8Array,
  options: EpubConvertOptions,
  context: PrepareEpubDocumentContext,
): PreparedEpubDocument {
  const warnings: EpubWarning[] = [];

  const entries = extractEpubArchive(bytes, context.limits);
  validateEpubMimetype(entries);
  const opfPath = locatePackageDocument(entries);
  const pkg = parsePackageDocument(entries, opfPath, context.filename);
  if (pkg.isFixedLayout) {
    throw new EpubError("FIXED_LAYOUT_UNSUPPORTED");
  }

  const nav = parseEpubNavigation(entries, pkg);
  const navLocation = locateNavigationDocument(pkg);
  // Spec §8.6 (revised — bug report "目次を含めないでも目次ページが本文に
  // 残る"): the EPUB3 navigation document is excluded from renderedSpine
  // UNCONDITIONALLY now, not only when includeTableOfContents=true. nav.xhtml
  // is a navigation artifact, not book text — its links don't function once
  // rendered as a plain XTC page — so both settings now mean what they say:
  // includeTableOfContents=false means no navigation content at all (not
  // "the EPUB's own nav page, verbatim"), and =true means "buildTocSection's
  // generated <nav class=epub-generated-toc>", never a duplicate of the
  // original. Deliberately does NOT extend to an EPUB2 NCX (navLocation?.kind
  // === "ncx"): the NCX is never itself a spine item (it has no
  // application/xhtml+xml-family media type, so isRenderableSpineMediaType
  // already excludes it below regardless), so there is nothing analogous to
  // exclude here for EPUB2.
  const excludedNavPath = navLocation?.kind === "nav" ? navLocation.path : undefined;

  // Spec §8.7 fix (bug report "無害なDOCTYPEで目次解析が全滅する" — see
  // errors.ts's assertNoXxeMarkers doc comment for the root cause this
  // guards against): the manifest names a TOC document but parseEpubNavigation
  // still came back empty (assertNoXxeMarkers's catch-all in navigation.ts,
  // spec §8.7's "目次解析に失敗しても本文変換は継続する" — the parse itself
  // is still allowed to fail silently, this only makes the failure visible).
  // Never fires for an EPUB with no TOC manifest item at all (navLocation
  // undefined) — that is the ordinary, unremarkable "no TOC in the source"
  // case, not a failure.
  if (navLocation !== undefined && nav.source === "none") {
    warnings.push({ code: "XTC_CHAPTER_TOC_PARSE_FAILED" });
  }

  const renderedSpine = pkg.spine.filter(
    (item) =>
      item.linear &&
      item.manifestItem.absolutePath !== excludedNavPath &&
      isRenderableSpineMediaType(item.manifestItem.mediaType),
  );
  if (renderedSpine.length === 0) {
    // Reachable in practice only for a malformed/degenerate EPUB whose sole
    // linear, renderable spine item(s) ARE the nav document itself (e.g. a
    // one-page book whose only spine entry is nav.xhtml) — a real book
    // always has at least one non-nav chapter. Same EMPTY_SPINE code/message
    // opf.ts's own "spine has zero itemref" case uses (spec §8.6 "spine が
    // 空の場合は422"); this is that same client-facing outcome, just
    // detected one filtering step later, so there is no separate error code
    // to invent for "spine became empty only after excluding nav" versus
    // "spine was empty from the start".
    throw new EpubError("EMPTY_SPINE", "no linear XHTML spine items after filtering");
  }

  const spineIndexByPath = new Map<string, number>();
  renderedSpine.forEach((item, idx) => spineIndexByPath.set(item.manifestItem.absolutePath, idx));

  // XTC chapter/table-of-contents metadata (top-level TOC entries only —
  // buildXtcChapterPlan's own doc comment). `candidates` is finalized into
  // `xtcChapters` further below, once the sanitization loop has actually
  // discovered which spine items rendered and which fragment ids were
  // found.
  const { candidates: xtcChapterCandidates, markerPlanByIndex, unresolvedTocTargetCount } =
    buildXtcChapterPlan(nav, spineIndexByPath);
  if (unresolvedTocTargetCount > 0) {
    warnings.push({ code: "XTC_CHAPTER_TOC_TARGET_UNRESOLVED" });
  }
  // Populated by the sanitization loop below: a target spine index lands
  // here when the WHOLE chapter never made it into the rendered document
  // (missing bytes, unparseable XHTML, or skipped as a cover duplicate) —
  // every candidate targeting it is dropped, fragment or not.
  const failedSpineIndexes = new Set<number>();
  // Populated by the sanitization loop below: target spine index -> the set
  // of requested fragment ids sanitizeSpineChapter reported as never found
  // in that (successfully rendered) chapter.
  const unresolvedFragmentsByIndex = new Map<number, Set<string>>();

  const { resolveRelative, resolveAbsolute, imageCount } = makeImageResolution(entries, pkg.manifest);

  // Resolved once, up front (not inside buildCoverSection) so the
  // cover-duplicate skip below and the section builder share the exact same
  // value — same rationale as makeImageResolution's own cache: this is the
  // one image every "is this spine item just the cover again" comparison is
  // pinned against.
  const coverDataUrl =
    options.includeCover && pkg.coverImagePath !== undefined ? resolveAbsolute(pkg.coverImagePath) : undefined;

  const chapterSections: string[] = [];
  const sanitizedCssTexts: string[] = [];
  // Comment-stripped, but otherwise NOT run through sanitizeCss's property
  // allowlist — copies of every stylesheet/inline-<style> text the loop
  // below reads, collected purely for detectLayout's own-CSS signal.
  // sanitizeCss now drops `writing-mode` outright (css.ts's
  // ALLOWED_PROPERTIES doc comment), so sanitizedCssTexts itself can never
  // contain it; detecting "this EPUB's own CSS declares vertical-rl" has to
  // read text sanitizeCss never filtered instead. Comments are still
  // stripped (via css.ts's own stripComments, exported for exactly this)
  // so a commented-out `/* writing-mode: vertical-rl; */` can't cause a
  // false-positive detection — see stripComments's own doc comment for the
  // one remaining gap (`@supports` conditions) this does NOT close. This is
  // a narrower, less careful read than readPageProgressionDirection's above
  // (which fully parses the OPF as XML and reads a specific attribute) —
  // it's a plain regex presence-check over comment-stripped-but-otherwise-
  // unsanitized text, not the "same technique". Still safe: a boolean
  // presence-check never risks emitting or executing anything from this
  // text.
  const cssTextsForLayoutDetection: string[] = [];
  const seenCssAbsPaths = new Set<string>();

  renderedSpine.forEach((item, idx) => {
    const path = item.manifestItem.absolutePath;
    const raw = entries.get(path);
    if (raw === undefined) {
      warnings.push({ code: "SPINE_ITEM_MISSING" });
      failedSpineIndexes.add(idx);
      return;
    }
    const xhtml = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(raw);
    const ctx: ChapterLinkContext = { chapterIndex: idx, chapterPath: path, spineIndexByPath };
    const sanitized = sanitizeSpineChapter(xhtml, ctx, resolveRelative, markerPlanByIndex.get(idx));
    if (sanitized === undefined) {
      warnings.push({ code: "CHAPTER_UNPARSEABLE" });
      failedSpineIndexes.add(idx);
      return;
    }

    if (coverDataUrl !== undefined && isCoverDuplicateSpineItem(sanitized, coverDataUrl)) {
      warnings.push({ code: "COVER_DUPLICATE_SKIPPED" });
      failedSpineIndexes.add(idx);
      return;
    }

    if (sanitized.unresolvedMarkerIds.length > 0) {
      // Not warned here directly — folded into the single
      // XTC_CHAPTER_DROPPED warning emitted below once every candidate has
      // been resolved (or not), so a chapter dropped for THIS reason and one
      // dropped because its whole spine item never rendered don't produce
      // two differently-coded warnings for what is, to anyone reading
      // warning codes, the same outcome: "requested chapter, no marker in
      // the output".
      unresolvedFragmentsByIndex.set(idx, new Set(sanitized.unresolvedMarkerIds));
    }

    for (const href of sanitized.stylesheetHrefs) {
      let absPath: string;
      try {
        absPath = resolveEpubRelativePath(path, href);
      } catch {
        continue;
      }
      if (seenCssAbsPaths.has(absPath)) {
        continue;
      }
      seenCssAbsPaths.add(absPath);
      const manifestItem = findManifestItemByPath(pkg.manifest, absPath);
      if (manifestItem === undefined || manifestItem.mediaType !== "text/css") {
        continue; // spec §10.1: only manifest-declared text/css stylesheets are read
      }
      const cssBytes = entries.get(absPath);
      if (cssBytes === undefined) {
        continue;
      }
      const cssText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(cssBytes);
      cssTextsForLayoutDetection.push(stripComments(cssText));
      const resolver: CssUrlResolver = (rawUrl) => resolveRelative(rawUrl, absPath);
      const sanitizedCss = sanitizeCss(cssText, resolver);
      if (sanitizedCss.trim().length > 0) {
        sanitizedCssTexts.push(sanitizedCss);
      }
    }
    for (const styleText of sanitized.inlineStyleTexts) {
      cssTextsForLayoutDetection.push(stripComments(styleText));
      const resolver: CssUrlResolver = (rawUrl) => resolveRelative(rawUrl, path);
      const sanitizedCss = sanitizeCss(styleText, resolver);
      if (sanitizedCss.trim().length > 0) {
        sanitizedCssTexts.push(sanitizedCss);
      }
    }

    const title = findChapterTitle(nav, path);
    const ariaLabel = title !== undefined ? ` aria-label="${escapeHtml(title)}"` : "";
    chapterSections.push(
      `<section id="${chapterSectionId(idx)}" class="epub-spine-item" data-spine-index="${idx}"${ariaLabel}>\n${sanitized.bodyHtml}\n</section>`,
    );
  });

  if (chapterSections.length === 0) {
    throw new EpubError("EMPTY_SPINE", "every spine item failed to sanitize");
  }

  // XTC chapters, finalized: a candidate survives only if its target spine
  // item actually rendered AND (fragment entries only) its id was actually
  // found there — see buildXtcChapterPlan's own doc comment for why a
  // candidate can be dropped at this late a stage despite having been a
  // "top-level TOC entry with a resolvable spine target" earlier. Dropping
  // here (rather than only warning) is what keeps every entry in the final
  // `chapters` array backed by a marker that is actually present in `html`
  // below — the invariant the caller (src/workflow.ts) relies on when it
  // forwards this array to the Container unchanged.
  let xtcChapterDropCount = 0;
  const xtcChapters: XtcChapter[] = [];
  for (const candidate of xtcChapterCandidates) {
    if (failedSpineIndexes.has(candidate.targetIndex)) {
      xtcChapterDropCount++;
      continue;
    }
    if (
      candidate.fragment.length > 0 &&
      unresolvedFragmentsByIndex.get(candidate.targetIndex)?.has(candidate.fragment) === true
    ) {
      xtcChapterDropCount++;
      continue;
    }
    xtcChapters.push(candidate.chapter);
  }
  if (xtcChapterDropCount > 0) {
    warnings.push({ code: "XTC_CHAPTER_DROPPED" });
  }

  const layout = detectLayout(pkg, entries, cssTextsForLayoutDetection, options.layout);
  const coverSection = coverDataUrl !== undefined ? buildCoverSection(coverDataUrl) : undefined;
  const tocSection = options.includeTableOfContents ? buildTocSection(nav, spineIndexByPath) : undefined;
  const finalCss = buildFinalCss(options, layout, options.layout !== "auto", xtcChapters.length > 0);

  const authorMeta =
    pkg.metadata.author !== undefined
      ? `\n<meta name="author" content="${escapeHtml(pkg.metadata.author)}">`
      : "";

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(pkg.metadata.title)}</title>${authorMeta}
<style>
${styleSafe(sanitizedCssTexts.join("\n"))}
</style>
<style>
${styleSafe(finalCss)}
</style>
</head>
<body>
${coverSection ?? ""}
${tocSection ?? ""}
<main class="epub-book">
${chapterSections.join("\n")}
</main>
</body>
</html>
`;

  const htmlBytes = new TextEncoder().encode(html).byteLength;
  if (htmlBytes > context.limits.maxHtmlBytes) {
    throw new EpubError("HTML_TOO_LARGE");
  }

  return {
    html,
    title: pkg.metadata.title,
    author: pkg.metadata.author,
    layout,
    spineItemCount: chapterSections.length,
    imageCount: imageCount(),
    warnings,
    chapters: xtcChapters,
    tocSource: nav.source,
  };
}
