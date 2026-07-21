// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { TextConvertOptions } from "./text-options";

/**
 * Reading-HTML generation for uploaded TXT files (text-upload spec §9/§15).
 * Every input is always treated as plain text — never HTML or Markdown
 * (spec §4.1/§17): escapeHtml is mandatory on every user-derived string that
 * lands in the document, and no external URL/script/stylesheet reference is
 * ever emitted (spec §15.3).
 */

/** Mandatory HTML-escaping (spec §4.1) — the sole defense against the TXT
 * body being interpreted as markup. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Converts already-normalized body text into paragraph HTML (spec §9.2):
 * blank-line-separated blocks become <p> elements, a single newline inside a
 * block becomes <br> (line-joining is explicitly out of scope for the MVP).
 */
export function textToParagraphHtml(normalizedText: string): string {
  return normalizedText
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}

const DEFAULT_TITLE = "Untitled";

/**
 * Resolves the document title (spec §15.4 priority): options.title, then the
 * filename with a trailing ".txt" removed, then "Untitled". `filename` is
 * expected to already be sanitized (src/text-upload.ts's sanitizeUploadFilename
 * equivalent) — display/title use only, never a path.
 */
export function resolveDocumentTitle(title: string, filename: string): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length > 0) {
    return trimmedTitle;
  }
  const withoutExt = filename.replace(/\.txt$/i, "").trim();
  return withoutExt.length > 0 ? withoutExt : DEFAULT_TITLE;
}

/** Body font stack: the chosen family, then a generic keyed on layout —
 * mirrors src/pdf.ts's fontStack() for the same reason (serif suits vertical
 * literary text, sans-serif the default horizontal layout). */
function fontStack(options: TextConvertOptions): string {
  return `"${options.font}", ${options.layout === "vertical" ? "serif" : "sans-serif"}`;
}

/**
 * Print CSS for the TXT reading layout (spec §9.3-9.7): fixed 528x792 CSS-px
 * page (the X3's pixel resolution, unlike the mm-based page geometry the
 * URL/PDF render paths use), every typographic knob driven by CSS custom
 * properties bound to TextConvertOptions. Deliberately self-contained — no
 * buildPrintRules() from src/pdf.ts (its rules target arbitrary scraped
 * sites, are all !important, and hard-code the 66mm/99mm page): the renderer
 * for this path (renderSelfStyledHtmlPdf, src/pdf.ts) injects only this
 * stylesheet plus the inlined font CSS, nothing else.
 */
export function buildTextPrintCss(options: TextConvertOptions): string {
  const { margins } = options;
  const justify =
    options.textAlign === "justify"
      ? `
  .content p {
    text-align: justify;
    text-justify: inter-character;
  }
`
      : "";
  const preserveSpaces = options.preserveSpaces
    ? `
  .content {
    white-space: pre-wrap;
    tab-size: 4;
  }
`
    : "";
  const contentRules =
    options.layout === "vertical"
      ? `
  .content {
    writing-mode: vertical-rl;
    text-orientation: mixed;
    overflow-wrap: anywhere;
    height: 100%;
  }

  .content p {
    margin-block-end: var(--paragraph-spacing);
  }
`
      : `
  .content {
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    overflow-wrap: anywhere;
  }

  .content p {
    margin: 0 0 var(--paragraph-spacing);
    orphans: 2;
    widows: 2;
  }
`;

  return `:root {
  --page-width: 528px;
  --page-height: 792px;
  --font-family: ${fontStack(options)};
  --font-size: ${options.fontSizePx}px;
  --line-height: ${options.lineHeight};
  --paragraph-spacing: ${options.paragraphSpacingEm}em;
  --margin-top: ${margins.top}px;
  --margin-right: ${margins.right}px;
  --margin-bottom: ${margins.bottom}px;
  --margin-left: ${margins.left}px;
}

@page {
  size: 528px 792px;
  margin: var(--margin-top) var(--margin-right) var(--margin-bottom) var(--margin-left);
}

html,
body {
  margin: 0;
  padding: 0;
  background: #fff;
  color: #000;
}

body {
  font-family: var(--font-family);
  font-size: var(--font-size);
  line-height: var(--line-height);
}
${contentRules}${justify}${preserveSpaces}`;
}

/** CSP for generated TXT article HTML (spec §17.1): no network access of any kind. */
const TEXT_ARTICLE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:;";

export interface BuildTextArticleHtmlInput {
  /** Already decoded + normalized (src/text-normalize.ts) TXT body. */
  normalizedText: string;
  options: TextConvertOptions;
  /** Resolved via resolveDocumentTitle — never options.title raw. */
  documentTitle: string;
}

/**
 * Builds the self-contained reading HTML document (spec §9.1) rendered by
 * renderSelfStyledHtmlPdf (src/pdf.ts). No external resource is ever
 * referenced — fonts ride in separately as inlined @font-face CSS
 * (src/fonts.ts's buildInlineFontCss, injected at render time), never a
 * <link>.
 */
export function buildTextArticleHtml({
  normalizedText,
  options,
  documentTitle,
}: BuildTextArticleHtmlInput): string {
  const title = options.title.trim();
  const author = options.author.trim();
  const showHeader = title.length > 0 || author.length > 0;
  const header = showHeader
    ? `    <header class="book-header">
${title.length > 0 ? `      <h1>${escapeHtml(title)}</h1>\n` : ""}${author.length > 0 ? `      <p class="author">${escapeHtml(author)}</p>\n` : ""}    </header>
`
    : "";
  const bodyHtml = textToParagraphHtml(normalizedText);
  const css = buildTextPrintCss(options);

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${TEXT_ARTICLE_CSP}">
  <title>${escapeHtml(documentTitle)}</title>
  <style>
${css}
  </style>
</head>
<body>
  <main class="book">
${header}    <article class="content">
${bodyHtml}
    </article>
  </main>
</body>
</html>
`;
}
