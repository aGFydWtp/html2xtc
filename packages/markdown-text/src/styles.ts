// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Structural CSS for Markdown reading HTML (spec §15), shared verbatim by
 * production (src/text-html.ts's buildTextDocumentShell) and the frontend's
 * live body preview — the same "one shared stylesheet, no separate copy"
 * requirement @html2xtc/aozora-text/styles.ts already follows for the
 * aozora branch.
 *
 * Every selector here is scoped under `.content` (the class the generated
 * document shell always wraps content in — src/text-html.ts's
 * buildTextDocumentShell) per spec §15's own concept example, so this
 * stylesheet can be concatenated alongside the shell's own print CSS
 * without any selector collision.
 *
 * Design constraints followed throughout (spec §15):
 * - Logical properties (margin-inline/-block, border-inline-start, ...)
 *   over physical ones — a physical left/right margin would indent the
 *   wrong axis once the root switches to `writing-mode: vertical-rl`
 *   (src/text-html.ts's buildTextPrintCss), exactly like
 *   @html2xtc/aozora-text/styles.ts's own indent rules.
 * - Every distinction (list markers, blockquote, table borders, code) reads
 *   correctly under a 1-bit black/white e-ink render: borders/rules, never
 *   a background color alone.
 * - No external resource of any kind (no @import, no url(), no @font-face
 *   here — inline font CSS is injected separately by the caller).
 *
 * Deliberately NOT done here (see the writing-mode note below): forcing
 * `pre`/`code`/`table` into a horizontal `writing-mode` when the document
 * is vertical. Spec §15.1 marks that as optional ("扱ってよい", not
 * required) specifically because a *nested* `writing-mode` on a large block
 * is a known Chromium print-pagination hazard on this service's actual
 * renderer — src/text-html.ts's buildTextPrintCss carries its own explicit
 * comment about exactly this failure mode ("入れ子要素に writing-mode を
 * 付けると... 白紙のPDFになる"), discovered and pinned down against the
 * production Cloudflare Browser Rendering binding, not just a local
 * Chromium build. Phase 4 (実環境確認, spec §24) — an actual
 * Browser-Rendering pass with a long code block/wide table in a vertical
 * document — is what would justify safely opting back into the horizontal
 * treatment; until that has been run, staying with the proven-safe default
 * (every block inherits the root's own writing-mode) is the conservative
 * choice per this repo's text-first CSS policy: never risk losing whole
 * pages of body content for a code/table orientation nicety.
 */

import { XTC_CHAPTER_MARKER_CSS } from "../../aozora-text/src/chapters";

export const MARKDOWN_DOCUMENT_CSS = `
.content h1,
.content h2,
.content h3,
.content h4,
.content h5,
.content h6 {
  break-after: avoid;
  margin-block-start: 1.2em;
  margin-block-end: 0.55em;
  line-height: 1.35;
  font-weight: bold;
}

.content h1 { font-size: 1.6em; }
.content h2 { font-size: 1.4em; }
.content h3 { font-size: 1.2em; }
.content h4 { font-size: 1.1em; }
.content h5,
.content h6 { font-size: 1em; }

.content ul,
.content ol {
  margin-block: 0.6em;
  padding-inline-start: 1.4em;
}

.content li {
  margin-block-end: 0.3em;
}

.content blockquote {
  margin-inline: 1em 0;
  margin-block: 0.8em;
  padding-inline-start: 0.8em;
  border-inline-start: 2px solid currentColor;
}

.content code {
  font-family: ui-monospace, "Courier New", monospace;
}

.content :not(pre) > code {
  border: 1px solid currentColor;
  padding: 0 0.25em;
  overflow-wrap: anywhere;
}

.content pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid currentColor;
  padding: 0.6em;
  margin-block: 0.8em;
  /* Long code blocks must stay free to split across a page break — never
     "avoid" here (spec §15.1 / this repo's text-first CSS policy: content
     must never be pushed off the page to keep a block visually intact). */
  break-inside: auto;
}

.content pre code {
  border: none;
  padding: 0;
}

.content hr {
  border: none;
  border-block-start: 1px solid currentColor;
  margin-block: 1.2em;
}

.content table {
  border-collapse: collapse;
  max-inline-size: 100%;
  margin-block: 0.8em;
}

.content th,
.content td {
  border: 1px solid currentColor;
  padding: 0.25em 0.4em;
  overflow-wrap: anywhere;
}

.content th {
  font-weight: bold;
}

.content .md-link {
  text-decoration: underline;
}

.content .md-image-placeholder {
  font-style: italic;
}

/* --- XTC chapter markers (aozora-text's chapters.ts) -------------------- */
${XTC_CHAPTER_MARKER_CSS}
`;
