// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

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
import type { ChapterLinkContext, ImageResolver, SanitizedChapter } from "./sanitize";
import type { EpubManifestItem, EpubNavigation, EpubPackageDocument } from "./types";
import { firstByLocalName, parseXmlDocument } from "./xml";

/**
 * Self-contained X3 HTML generation (EPUB spec §11-§13): orchestrates
 * archive extraction, package/nav parsing (Phase 2), per-chapter XHTML
 * sanitization (sanitize.ts), CSS collection + sanitization (css.ts), image
 * Data-URL resolution (assets.ts), cover/TOC assembly, layout detection, and
 * the final X3 correction stylesheet — into the single entrypoint Phase 4's
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

// --- final X3 correction CSS ------------------------------------------------

/**
 * Spec §13.1/§13.2/§12.1: fixed 528x792 page geometry, the chosen font
 * forced over the EPUB's own (font references were already stripped —
 * D3/D12), the image-sizing rules (§11.2), and the optional
 * chapter-page-break rule (§9.2). Explicit (non-"auto") layout choices win
 * over the EPUB's own CSS via `!important`; "auto" only supplements it.
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
 * already relies on (buildTextPrintCss) for the same 528x792 page. Matching
 * that file, `html`/`body` no longer hard-code `width`/`min-height`: the
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
function buildFinalCss(options: EpubConvertOptions, layout: "horizontal" | "vertical", layoutIsExplicit: boolean): string {
  const important = layoutIsExplicit ? " !important" : "";
  const genericFamily = layout === "vertical" ? "serif" : "sans-serif";
  const pageBreakRule = options.chapterPageBreak
    ? `.epub-spine-item + .epub-spine-item {\n  break-before: page;\n  page-break-before: always;\n}\n`
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
  // The cover page has no text to fragment across pages, so it can simply
  // be sized to fill its one page's content box (page width/height minus
  // the @page margin on every side) and centered — no separate padding
  // needed, @page's margin already insets it like every other page. Both
  // dimensions are needed, not just height — see .epub-cover's own doc
  // comment below for why.
  const coverContentWidthPx = Math.max(0, 528 - options.marginPx * 2);
  const coverContentHeightPx = Math.max(0, 792 - options.marginPx * 2);
  return `@page {
  size: 528px 792px;
  margin: ${options.marginPx}px;
}

html, body {
  margin: 0;
  padding: 0;
  background: #fff;
  color: #000;
}

${writingModeRule}
html, body, .epub-book {
  font-family: "${options.font}", ${genericFamily}${important};
  font-size: ${options.fontSizePx}px;
}

pre, code, kbd, samp {
  font-family: monospace${important};
}

img, svg {
  max-width: 100%;
  max-height: 100%;
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
  /* Both width and height must be explicit (not e.g. min-height alone):
     max-width/max-height:100% on the <img> below only resolves against a
     containing block whose size in that axis is definite — CSS spec's rule
     for percentage sizes, not this codebase's assumption. With only
     min-height set (the prior version of this rule), the box's HEIGHT
     still counted as indefinite for that purpose, so max-height:100%
     computed to "none" and the <img> rendered at its raw intrinsic pixel
     size instead. Empirically reproduced against 熊野奈智山.epub's real
     600x800 cover in an actual Chromium print render: the oversized image
     fragment spilled onto page 2, which pushed .epub-cover's content off
     page 1 entirely and left it fully blank. width has the same
     requirement even though it was never observed failing on its own here
     (a definite height alone happened to be enough for this specific
     nearly-page-sized image) — giving both is the actually-correct fix,
     not a guess. overflow:hidden is a backstop only, not the fix itself:
     with both dimensions definite, max-width/max-height:100% plus
     object-fit:contain (above) already guarantee the whole image fits and
     is never cropped — overflow:hidden just guarantees a future regression
     clips invisibly instead of silently pushing content onto the next
     page's fragment the way this bug did. */
  width: ${coverContentWidthPx}px;
  height: ${coverContentHeightPx}px;
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

${pageBreakRule}`;
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
 * fetches a web font itself. Its `<style>` only sets `font-family` to the
 * user's chosen family BY NAME; Phase 4 is responsible for calling
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
  const excludedNavPath =
    options.includeTableOfContents && navLocation?.kind === "nav" ? navLocation.path : undefined;

  const renderedSpine = pkg.spine.filter(
    (item) =>
      item.linear &&
      item.manifestItem.absolutePath !== excludedNavPath &&
      isRenderableSpineMediaType(item.manifestItem.mediaType),
  );
  if (renderedSpine.length === 0) {
    throw new EpubError("EMPTY_SPINE", "no linear XHTML spine items after filtering");
  }

  const spineIndexByPath = new Map<string, number>();
  renderedSpine.forEach((item, idx) => spineIndexByPath.set(item.manifestItem.absolutePath, idx));

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
      return;
    }
    const xhtml = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(raw);
    const ctx: ChapterLinkContext = { chapterIndex: idx, chapterPath: path, spineIndexByPath };
    const sanitized = sanitizeSpineChapter(xhtml, ctx, resolveRelative);
    if (sanitized === undefined) {
      warnings.push({ code: "CHAPTER_UNPARSEABLE" });
      return;
    }

    if (coverDataUrl !== undefined && isCoverDuplicateSpineItem(sanitized, coverDataUrl)) {
      warnings.push({ code: "COVER_DUPLICATE_SKIPPED" });
      return;
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

  const layout = detectLayout(pkg, entries, cssTextsForLayoutDetection, options.layout);
  const coverSection = coverDataUrl !== undefined ? buildCoverSection(coverDataUrl) : undefined;
  const tocSection = options.includeTableOfContents ? buildTocSection(nav, spineIndexByPath) : undefined;
  const finalCss = buildFinalCss(options, layout, options.layout !== "auto");

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
  };
}
