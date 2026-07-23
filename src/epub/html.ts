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
import { sanitizeCss } from "./css";
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
 * Data-URL resolution (assets.ts), cover/TOC/colophon assembly, layout
 * detection, and the final X3 correction stylesheet — into the single
 * entrypoint Phase 4's Workflow calls: prepareEpubDocument.
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
  /** The uploaded EPUB's original filename — spec §8.4.1's title fallback and the colophon's "元ファイル名" line. */
  filename: string;
  limits: EpubArchiveLimits & {
    /** D11: the generated HTML's own size cap (MAX_EPUB_HTML_BYTES). */
    maxHtmlBytes: number;
  };
  /** Injection point for deterministic tests; defaults to `new Date()`. */
  now?: Date;
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

/** Spec §12: layout="auto" resolution order — explicit page-progression-direction+Japanese language, then a vertical-rl writing-mode already present in the EPUB's own (sanitized) CSS, else horizontal. "日本語だから自動的に縦書きにはしない" — dc:language alone is never sufficient. */
function detectLayout(
  pkg: EpubPackageDocument,
  entries: Map<string, Uint8Array>,
  sanitizedCssTexts: string[],
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
  if (sanitizedCssTexts.some((css) => /writing-mode\s*:\s*vertical-rl/i.test(css))) {
    return "vertical";
  }
  return "horizontal";
}

// --- nav / TOC / cover / colophon -----------------------------------------

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

function formatJstTimestamp(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())} JST`;
}

/** Spec §13.3: EPUB has no source URL, so the colophon shows title/author/format/original filename/conversion time plus the fixed personal-use notice (matches src/text-html.ts's wording). Built via escapeHtml'd template strings, not linkedom DOM serialization — see prepareEpubDocument's doc comment for why that sidesteps the <title>/<style> verbatim-serialize hazard src/printhtml.ts has to guard against explicitly. */
function buildColophon(pkg: EpubPackageDocument, filename: string, convertedAt: string): string {
  const lines = [
    `タイトル: ${pkg.metadata.title}`,
    ...(pkg.metadata.author !== undefined ? [`著者: ${pkg.metadata.author}`] : []),
    "入力形式: EPUB",
    `元ファイル名: ${filename}`,
    `変換日時: ${convertedAt}`,
    "個人的利用のために作成。再配布禁止。",
    "Created for personal use. Redistribution prohibited.",
  ];
  return `<section class="epub-colophon">\n${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("\n")}\n</section>`;
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
 * writing-mode placement: `html` only, never a descendant. Copied from
 * src/text-html.ts's own doc comment (empirically verified against this
 * exact 528x792 @page): Chromium's print pagination cannot split a
 * `vertical-rl` fragmentation context that starts below the document root,
 * so a *second* nested `writing-mode: vertical-rl` (even one that merely
 * repeats the same value) can turn every page after the first blank. This
 * is why the vertical rule below lives solely on `html` (with no override
 * capability reaching further down) while the horizontal rule targets
 * `.epub-book`, mirroring text-html.ts's own asymmetry (root only for
 * vertical-rl, a content wrapper is fine for horizontal-tb — horizontal-tb
 * never creates a page-splitting formatting context boundary, so it carries
 * none of that hazard, and it's where an explicit "horizontal" layout
 * actually needs to reach in order to override an EPUB's own body/content
 * writing-mode).
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
  // be sized to fill its one page's content box (page height minus the
  // @page margin applied top+bottom) and centered — no separate padding
  // needed, @page's margin already insets it like every other page.
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
  float: none !important;
}

figure {
  break-inside: avoid;
}

.epub-cover {
  min-height: ${coverContentHeightPx}px;
  display: flex;
  align-items: center;
  justify-content: center;
  break-after: page;
  page-break-after: always;
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
      const resolver: CssUrlResolver = (rawUrl) => resolveRelative(rawUrl, absPath);
      const sanitizedCss = sanitizeCss(cssText, resolver);
      if (sanitizedCss.trim().length > 0) {
        sanitizedCssTexts.push(sanitizedCss);
      }
    }
    for (const styleText of sanitized.inlineStyleTexts) {
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

  const layout = detectLayout(pkg, entries, sanitizedCssTexts, options.layout);
  const coverSection = coverDataUrl !== undefined ? buildCoverSection(coverDataUrl) : undefined;
  const tocSection = options.includeTableOfContents ? buildTocSection(nav, spineIndexByPath) : undefined;
  const convertedAt = formatJstTimestamp(context.now ?? new Date());
  const colophon = buildColophon(pkg, context.filename, convertedAt);
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
${colophon}
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
