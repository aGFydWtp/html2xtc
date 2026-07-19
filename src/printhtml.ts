// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { parseHTML } from "linkedom";
import type { ExtractedArticle } from "./extract";

/**
 * Print-HTML assembly for extract mode: sanitizes the Readability output and
 * wraps it into a self-contained document (title, source line, article body,
 * static colophon) that renderPdfFromHtml() hands to Browser Run.
 *
 * Design rules carried over from pdf.ts's buildColophonScript:
 * - Page-derived text only ever goes through createElement + textContent,
 *   never string concatenation into HTML.
 * - The colophon is a <div> with an id and no class, so the header/footer/
 *   [class~=...] hide rules in X3_PRINT_CSS can never match it.
 * - All colophon styles are inline with !important, which beats the
 *   stylesheet's own !important (e.g. the 10pt div normalization) in the
 *   cascade.
 */

/**
 * Elements dropped from the article content. Readability removes most
 * script/style itself but guarantees nothing, and the text-first print policy
 * (see project memory) cuts embeds and interactive controls outright; img and
 * svg stay — X3_PRINT_CSS clamps them to the page width.
 */
const STRIP_SELECTOR = [
  "script",
  "noscript",
  "template",
  "iframe",
  "frame",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "style",
  "link",
  "meta",
  "audio",
  "video",
  "source",
  "track",
  "dialog",
].join(", ");

const COLOPHON_LINE_STYLE =
  "margin:0 !important;padding:0 !important;font-size:8pt !important";

/** Structural subset of a DOM element the attribute helpers rely on. */
interface AttrElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Deferred-URL attributes used by the common lazy-load libraries (lazysizes,
 * WP Rocket, jQuery.lazyload, ...), checked in order when an img has no
 * usable src. Script/noscript are stripped before this runs, so nothing on
 * the page can do this promotion itself — the sanitizer must.
 */
const LAZY_SRC_ATTRIBUTES = ["data-src", "data-lazy-src", "data-original"] as const;

/** srcset-shaped fallbacks, tried after LAZY_SRC_ATTRIBUTES. */
const LAZY_SRCSET_ATTRIBUTES = ["srcset", "data-srcset", "data-lazy-srcset"] as const;

/**
 * Lazy-load leftovers removed from every img once normalization ran: the
 * attribute loop in sanitizeContent only strips srcset/sizes, so data-*
 * variants would otherwise survive with unresolved (relative) URLs.
 */
const LAZY_CLEANUP_ATTRIBUTES = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-srcset",
  "data-lazy-srcset",
  "data-sizes",
] as const;

/** X3 output width in px — the srcset candidate target. */
const TARGET_IMAGE_WIDTH = 528;

/**
 * Sanitizes a Readability content fragment for printing:
 * - removes STRIP_SELECTOR elements;
 * - strips on* handlers, inline styles (a known layout hazard on the 58mm
 *   page, see the carousel width-pin notes in pdf.ts) and srcset/sizes
 *   (pointless at the X3's 528px output width — src alone is enough);
 * - resolves relative src/href against the page URL and drops non-http(s)
 *   schemes (javascript:, data:, ...);
 * - normalizes lazy-loaded images: promotes data-src/data-srcset style
 *   deferred URLs onto src and drops loading="lazy", because the sanitized
 *   document is rendered statically (scripts stripped, page never scrolled)
 *   and would otherwise capture placeholder or missing images;
 * - drops the content's leading h1/h2 when it duplicates `title`, which
 *   buildPrintHtml renders as its own <h1>.
 */
export function sanitizeContent(
  contentHtml: string,
  baseUrl: string,
  title?: string,
): string {
  const { document } = parseHTML(
    `<!doctype html><html><head></head><body>${contentHtml}</body></html>`,
  );
  const body = document.body;

  for (const el of [...body.querySelectorAll(STRIP_SELECTOR)]) {
    el.remove();
  }

  // Before the attribute loop, so a promoted src goes through the same URL
  // resolution / scheme check as an authored one. Known limitation: <source>
  // is in STRIP_SELECTOR, so a <picture> whose real URLs live ONLY on its
  // <source> elements cannot be rescued — the surviving <img> is normalized
  // from whatever src/srcset/data-* it carries itself, nothing more.
  for (const img of [...body.querySelectorAll("img")]) {
    normalizeLazyImage(img);
  }

  for (const el of [...body.querySelectorAll("*")]) {
    for (const name of [...el.getAttributeNames()]) {
      if (
        /^on/i.test(name) ||
        name === "style" ||
        name === "srcset" ||
        name === "sizes"
      ) {
        el.removeAttribute(name);
        continue;
      }
      // Bare href/src AND namespace-prefixed variants (xlink:href on
      // <svg><image> etc.) — a prefixed URL attribute must not bypass the
      // scheme check or keep pointing at a relative/internal target.
      if (/(?:^|:)(?:href|src)$/i.test(name)) {
        resolveUrlAttribute(el, name, baseUrl);
      }
    }
  }

  const wanted = normalizeHeadingText(title);
  if (wanted.length > 0) {
    const heading = body.querySelector("h1, h2");
    if (
      heading !== null &&
      normalizeHeadingText(heading.textContent as string | null) === wanted
    ) {
      heading.remove();
    }
  }

  return body.innerHTML;
}

/** Whitespace-insensitive comparison key for the duplicate-title check. */
function normalizeHeadingText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, "").toLowerCase();
}

/**
 * Resolves a URL-carrying attribute (href/src, including namespace-prefixed
 * forms like xlink:href) against the page URL and drops the attribute
 * entirely when the result is not a plain http(s) URL (javascript:, data:,
 * malformed, ...). A missing image beats a scriptable URL in a document we
 * author ourselves.
 */
function resolveUrlAttribute(
  el: AttrElement,
  name: string,
  baseUrl: string,
): void {
  const value = el.getAttribute(name);
  if (value === null) {
    return;
  }
  try {
    const resolved = new URL(value, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      el.removeAttribute(name);
      return;
    }
    el.setAttribute(name, resolved.toString());
  } catch {
    el.removeAttribute(name);
  }
}

/**
 * Normalizes one img for static rendering:
 * - when src is missing or a placeholder (empty, data:/about:/blob:, or a
 *   spacer-file name), promotes the first deferred URL from
 *   LAZY_SRC_ATTRIBUTES, falling back to a srcset-shaped attribute via
 *   pickFromSrcset;
 * - drops loading="lazy" — Chromium's native lazy-loading skips
 *   below-viewport images and the print path never scrolls, so a surviving
 *   lazy hint means a blank image in the PDF;
 * - removes the consumed lazy-load attributes (LAZY_CLEANUP_ATTRIBUTES).
 * The promoted value is deliberately NOT resolved here: the caller's
 * attribute loop applies resolveUrlAttribute to src afterwards, which also
 * discards a promoted javascript:/data: value.
 */
function normalizeLazyImage(el: AttrElement): void {
  if (isPlaceholderSrc(el.getAttribute("src"))) {
    let candidate: string | null = null;
    for (const name of LAZY_SRC_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value !== null && value.trim().length > 0) {
        candidate = value.trim();
        break;
      }
    }
    if (candidate === null) {
      for (const name of LAZY_SRCSET_ATTRIBUTES) {
        candidate = pickFromSrcset(el.getAttribute(name));
        if (candidate !== null) {
          break;
        }
      }
    }
    if (candidate !== null) {
      el.setAttribute("src", candidate);
    }
  }
  if ((el.getAttribute("loading") ?? "").trim().toLowerCase() === "lazy") {
    el.removeAttribute("loading");
  }
  for (const name of LAZY_CLEANUP_ATTRIBUTES) {
    el.removeAttribute(name);
  }
}

/**
 * True when src cannot be a real image: absent/blank, an inline scheme
 * (data:/about:/blob: — the classic 1px shim carriers), or a spacer-ish
 * file name (1x1.gif, blank.png, ...) that lazy-load libraries use as the
 * pre-load placeholder. Deliberately conservative: an unrecognized real URL
 * must never be overwritten by a data-* guess.
 */
function isPlaceholderSrc(src: string | null): boolean {
  if (src === null) {
    return true;
  }
  const value = src.trim();
  if (value.length === 0) {
    return true;
  }
  if (/^(?:data|about|blob):/i.test(value)) {
    return true;
  }
  return isPlaceholderFileName(value);
}

/**
 * Words a placeholder/spacer file name may consist of; used by
 * isPlaceholderFileName, which requires the WHOLE name to be made of these.
 */
const PLACEHOLDER_FILE_WORDS = new Set([
  "blank",
  "spacer",
  "placeholder",
  "transparent",
  "pixel",
  "dummy",
]);

/**
 * File-name heuristic for spacer images, strict on purpose: the entire stem
 * (split on - _ .) must be made of placeholder words
 * (PLACEHOLDER_FILE_WORDS), WxH dimension tokens (1x1, 300x200) or bare
 * numbers — so "blank.gif", "1x1.gif" and "placeholder-300x200.png" qualify.
 * Any other word disqualifies the name: a substring match would flag a
 * legitimate image like "pixel-art-collection.png", this does not. At least
 * one placeholder word or dimension token is required, so a purely numeric
 * name ("300.png") does not qualify either.
 */
function isPlaceholderFileName(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0] ?? "";
  const file = path.split("/").pop() ?? "";
  const match = /^(.+)\.(?:gif|png|svg)$/i.exec(file);
  if (match === null) {
    return false;
  }
  let qualifying = false;
  for (const token of match[1].split(/[-_.]+/)) {
    if (token.length === 0) {
      continue;
    }
    if (
      PLACEHOLDER_FILE_WORDS.has(token.toLowerCase()) ||
      /^\d+x\d+$/i.test(token)
    ) {
      qualifying = true;
      continue;
    }
    if (/^\d+$/.test(token)) {
      continue; // numbers alone neither qualify nor disqualify
    }
    return false; // any real word means a real image name
  }
  return qualifying;
}

/**
 * Picks one URL out of a srcset-shaped value, aimed at TARGET_IMAGE_WIDTH:
 * the smallest width descriptor that still covers it, else the largest
 * available; for density descriptors the lowest density (1x). Candidates are
 * split on bare commas, which mis-splits URLs that themselves contain a
 * comma: rare for http(s) URLs in real-world srcsets (worst case a malformed
 * candidate that resolveUrlAttribute later discards or resolves uselessly),
 * and for data: URLs — where commas are structural — whatever fragment gets
 * promoted is dropped by the scheme check.
 */
function pickFromSrcset(srcset: string | null): string | null {
  if (srcset === null) {
    return null;
  }
  interface Candidate {
    url: string;
    width: number | null;
    density: number | null;
  }
  const candidates: Candidate[] = [];
  for (const part of srcset.split(",")) {
    const tokens = part.trim().split(/\s+/);
    const url = tokens[0];
    if (url === undefined || url.length === 0) {
      continue;
    }
    let width: number | null = null;
    let density: number | null = null;
    const descriptor = tokens[1];
    if (descriptor !== undefined) {
      const match = /^(\d+(?:\.\d+)?)([wx])$/i.exec(descriptor);
      if (match === null) {
        continue; // unparseable descriptor — skip rather than misrank
      }
      if (match[2].toLowerCase() === "w") {
        width = Number(match[1]);
      } else {
        density = Number(match[1]);
      }
    }
    candidates.push({ url, width, density });
  }
  if (candidates.length === 0) {
    return null;
  }
  const withWidth = candidates.filter((c): c is Candidate & { width: number } => c.width !== null);
  if (withWidth.length > 0) {
    const covering = withWidth.filter((c) => c.width >= TARGET_IMAGE_WIDTH);
    const pool = covering.length > 0 ? covering : withWidth;
    const best =
      covering.length > 0
        ? pool.reduce((a, b) => (b.width < a.width ? b : a))
        : pool.reduce((a, b) => (b.width > a.width ? b : a));
    return best.url;
  }
  const best = candidates.reduce((a, b) =>
    (b.density ?? 1) < (a.density ?? 1) ? b : a,
  );
  return best.url;
}

/**
 * All text the print document will render, for the font subsetter
 * (src/fonts.ts): article body, title, source line and every colophon line
 * (static labels included). Over-inclusion is harmless — a few extra glyphs
 * in the subset — while a missing glyph would render in the fallback font.
 * Must stay in sync with what buildPrintHtml() actually emits.
 */
export function printableText(
  article: ExtractedArticle,
  sourceUrl: string,
  convertedAt: string,
): string {
  return [
    article.title ?? "(無題)",
    article.siteName ?? "",
    article.byline ?? "",
    hostnameOf(sourceUrl),
    sourceUrl,
    convertedAt,
    "タイトル: サイト名: 著者: URL: 変換日時: · ",
    "個人的利用のために作成。再配布禁止。",
    "Created for personal use. Redistribution prohibited.",
    article.textContent,
  ].join("");
}

/**
 * Builds the complete print document for an extracted article. `sourceUrl`
 * must be the URL the HTML was actually fetched from (after redirects) so
 * relative references resolve correctly; `convertedAt` comes from
 * formatJstTimestamp (pdf.ts), same as the full-page colophon.
 *
 * The document deliberately carries NO font reference (no <link>, no
 * <style> @font-face): the inlined font CSS travels next to the HTML
 * (RenderInput.fontCss) and renderPdfFromHtml injects it via addStyleTag —
 * the custom-font path the quick-action docs document — so a reference here
 * would be either dead weight or a duplicate fetch racing the injected
 * faces. (What makes the font apply at all is the top-level font-family
 * rule in X3_PRINT_RULES, outside @media print — see pdf.ts.)
 *
 * The <title> is always present: the Container reads the PDF title metadata
 * into X-Xtc-Title, which becomes the download filename (pipeline.ts).
 */
export function buildPrintHtml(
  article: ExtractedArticle,
  sourceUrl: string,
  convertedAt: string,
): string {
  const { document } = parseHTML(
    "<!doctype html><html><head></head><body></body></html>",
  );

  if (article.lang !== undefined) {
    document.documentElement.setAttribute("lang", article.lang);
  }

  const charset = document.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  document.head.appendChild(charset);

  // Safety net for any relative reference the sanitizer's URL rewriting
  // does not cover (e.g. url() inside surviving presentational markup).
  const base = document.createElement("base");
  base.setAttribute("href", sourceUrl);
  document.head.appendChild(base);

  // Same "(無題)" fallback as the full-page colophon script.
  const title = article.title ?? "(無題)";
  const titleEl = document.createElement("title");
  // linkedom serializes <title> children verbatim (no entity escaping), so a
  // title containing "</title>" could break out of the element; strip angle
  // brackets instead of trusting the serializer. The <h1> below keeps the
  // original text — element textContent IS escaped on serialization.
  titleEl.textContent = title.replace(/[<>]/g, " ");
  document.head.appendChild(titleEl);

  const heading = document.createElement("h1");
  heading.textContent = title;
  document.body.appendChild(heading);

  const sourceParts = [article.siteName, article.byline].filter(
    (part): part is string => part !== undefined,
  );
  if (sourceParts.length > 0) {
    const sourceLine = document.createElement("div");
    sourceLine.textContent = sourceParts.join(" · ");
    sourceLine.setAttribute(
      "style",
      `${COLOPHON_LINE_STYLE};margin-bottom:6pt !important`,
    );
    document.body.appendChild(sourceLine);
  }

  const content = document.createElement("div");
  // Already sanitized; this is the one deliberate innerHTML assignment.
  content.innerHTML = sanitizeContent(article.contentHtml, sourceUrl, article.title);
  document.body.appendChild(content);

  // Static colophon: same lines and constraints as buildColophonScript
  // (pdf.ts), but built server-side — a page CSP cannot block it here.
  const box = document.createElement("div");
  box.id = "xtc-colophon";
  box.setAttribute(
    "style",
    // break-before: page puts the colophon on its own final page.
    `break-before:page !important;line-height:1.6 !important;${COLOPHON_LINE_STYLE}`,
  );
  const addLine = (text: string, extraStyle?: string): void => {
    const line = document.createElement("div");
    line.textContent = text;
    line.setAttribute(
      "style",
      extraStyle === undefined
        ? COLOPHON_LINE_STYLE
        : `${COLOPHON_LINE_STYLE};${extraStyle}`,
    );
    box.appendChild(line);
  };
  addLine(`タイトル: ${title}`);
  addLine(`サイト名: ${article.siteName ?? hostnameOf(sourceUrl)}`);
  if (article.byline !== undefined) {
    addLine(`著者: ${article.byline}`);
  }
  addLine(`URL: ${sourceUrl}`);
  addLine(`変換日時: ${convertedAt}`);
  addLine("個人的利用のために作成。再配布禁止。",
    "border-top:1px solid black !important;margin-top:6pt !important;padding-top:4pt !important",
  );
  addLine("Created for personal use. Redistribution prohibited.");
  document.body.appendChild(box);

  return document.toString();
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
