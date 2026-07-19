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
 * Sanitizes a Readability content fragment for printing:
 * - removes STRIP_SELECTOR elements;
 * - strips on* handlers, inline styles (a known layout hazard on the 58mm
 *   page, see the carousel width-pin notes in pdf.ts) and srcset/sizes
 *   (pointless at the X3's 528px output width — src alone is enough);
 * - resolves relative src/href against the page URL and drops non-http(s)
 *   schemes (javascript:, data:, ...);
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

  for (const el of [...body.querySelectorAll("*")]) {
    for (const name of [...el.getAttributeNames()]) {
      if (
        /^on/i.test(name) ||
        name === "style" ||
        name === "srcset" ||
        name === "sizes"
      ) {
        el.removeAttribute(name);
      }
    }
    resolveUrlAttribute(el, "src", baseUrl);
    resolveUrlAttribute(el, "href", baseUrl);
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
 * Resolves a relative src/href against the page URL and drops the attribute
 * entirely when the result is not a plain http(s) URL (javascript:, data:,
 * malformed, ...). A missing image beats a scriptable URL in a document we
 * author ourselves.
 */
function resolveUrlAttribute(
  el: AttrElement,
  name: "src" | "href",
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
 * Builds the complete print document for an extracted article. `sourceUrl`
 * must be the URL the HTML was actually fetched from (after redirects) so
 * relative references resolve correctly; `convertedAt` comes from
 * formatJstTimestamp (pdf.ts), same as the full-page colophon.
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
