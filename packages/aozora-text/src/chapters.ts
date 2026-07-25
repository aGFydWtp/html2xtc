// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * XTC chapter/table-of-contents metadata: shared, dependency-free constants
 * and helpers for embedding an invisible "chapter marker" span immediately
 * before every heading chosen as this document's chapter level (see
 * render-html.ts's determineChapterHeadingLevel for how that level is
 * picked) — both in the AST-based TXT renderer (render-html.ts, this
 * package) and in the Aozora Bunko URL-extraction path (src/aozora.ts),
 * which already imports styles.ts from here for the identical "share one
 * implementation between the two Aozora paths" reason.
 *
 * Page numbers are never resolved here (or anywhere in the Worker): the
 * Worker only ever emits {name, marker} pairs. The Container (converter/)
 * locates each marker's page in the rendered PDF's own text layer and
 * resolves the page number there — see src/container.ts's X-Xtc-Chapters
 * header, the Worker→Container half of that contract. src/container.ts also
 * caps how many of these are ever sent (MAX_XTC_CHAPTERS there) — that limit
 * is deliberately NOT duplicated here: it is a Worker-only concern (which
 * headings become chapters is an editorial decision the Worker owns), not
 * something this shared, frontend-facing package should also encode.
 */

/** One chapter entry: a heading's readable name plus the exact marker
 * string embedded immediately before it (renderChapterMarkerHtml below).
 * Travels from extraction (render-html.ts's extractChapters / src/aozora.ts)
 * through src/workflow.ts to src/container.ts's convertInContainer, which
 * JSON-encodes an array of these as the X-Xtc-Chapters header. */
export interface XtcChapter {
  /** Readable heading text — no ruby reading and no raw annotation notation
   * (normalizeChapterName below), and no page number (the Container resolves
   * that from the rendered PDF). */
  name: string;
  /** Exactly the string embedded via renderChapterMarkerHtml immediately
   * before this chapter's heading — alphanumeric only (formatChapterMarker),
   * so it can never be split apart by a PDF text extractor the way a
   * marker containing punctuation could be. */
  marker: string;
}

/** The single CSS class every marker span carries — matched by
 * XTC_CHAPTER_MARKER_CSS below and, on the converter side, by whatever text
 * pattern the Container's PDF text-layer search looks for. */
export const XTC_CHAPTER_MARKER_CLASS = "xtc-chapter-marker";

/**
 * Renders the marker invisible in print/PDF output while keeping it in
 * Chromium's PDF text layer (`color: transparent` + `font-size: 1px`), and
 * ALSO invisible to a live DOM view — text selection and screen readers —
 * without touching either of those two properties (`user-select: none` +
 * `aria-hidden="true"` on the span itself, renderChapterMarkerHtml below).
 * This second half matters because the AST-based TXT renderer's output is
 * not print-only: frontend/src/components/TextInputPanel.svelte renders the
 * exact same renderDocumentToHtml() output as a live, selectable preview
 * (`{@html aozoraBodyHtml}`), and injects this exact stylesheet there too —
 * without `user-select: none`, a user copying the preview's body text would
 * get a stray `XTCCH0001` before every chapter heading; without
 * `aria-hidden`, a screen reader would announce it.
 *
 * Measured, not just reasoned about: a 30-page vertical-writing document
 * (`writing-mode: vertical-rl`, `@page { size: 528px 792px }`) was printed to
 * PDF via headless Chrome 150.0.7871.182 and its text layer inspected with
 * PyMuPDF, both with the marker as `color: transparent; font-size: 1px`
 * alone and with `user-select: none` + `aria-hidden="true"` added. The
 * marker text survived into the PDF's text layer in BOTH cases, unchanged —
 * confirming `user-select` (which only gates interactive selection in a live
 * view) and `aria-hidden` (which only affects the accessibility tree a
 * screen reader walks) really do leave Chromium's print-to-PDF paint output,
 * and therefore the PDF text layer sourced from it, untouched. The same
 * pass confirmed the opposite for every box-collapsing alternative tried —
 * `display: none`, `visibility: hidden`, `opacity: 0`, `font-size: 0`, and
 * `width: 0`/`inline-size: 0` variants — all of which removed the marker
 * from the text layer entirely, which is exactly why none of them is used
 * here.
 *
 * The same measurement found the marker is NOT layout-free: as an ordinary
 * inline element it still takes up a sliver of line-box space, shifting the
 * heading's own glyphs by roughly 7.5px in the printed PDF (about 6.75px
 * with `user-select: none` added) — `font-size: 1px` does not collapse to
 * a true 1px advance, apparently because Chromium enforces its own minimum
 * rendered font size underneath it; the exact shift is therefore not
 * guaranteed stable across Chromium versions. Every page break in that same
 * 30-page document landed identically with and without the marker, so this
 * shift is confined to the heading's own line and never propagates into
 * pagination — and even if it someday did, the marker sits on the exact
 * same line as the heading it marks, so the Container's page lookup for
 * that chapter would still be correct.
 *
 * `position: absolute` (no top/left set) was the one alternative that kept
 * the marker in the text layer AND fully eliminated the heading shift — and
 * is deliberately NOT used, because an absolutely positioned element is
 * pulled out of normal flow and out of Chromium's page-break accounting: if
 * a heading ever sits right at a page boundary, there is no guarantee which
 * page such a marker would be assigned to, risking an off-by-one-page
 * chapter start that the current inline placement cannot produce (the
 * marker is always laid out ON the heading's own line). A few px of
 * invisible heading drift is preferable to a wrong chapter page number.
 *
 * Embedded into AOZORA_DOCUMENT_CSS (styles.ts) so every renderer that
 * already includes that stylesheet (the AST-based TXT renderer, the Aozora
 * Bunko URL-extraction path, its 4-chunk fallback, and the frontend's live
 * aozora preview) picks up both the print-invisibility and the
 * copy/screen-reader-invisibility halves for free.
 */
export const XTC_CHAPTER_MARKER_CSS = `
.${XTC_CHAPTER_MARKER_CLASS} {
  color: transparent;
  font-size: 1px;
  user-select: none;
  -webkit-user-select: none;
}
`;

/**
 * Formats the Nth (1-based) chapter marker as `XTCCH` + 4-digit zero-padded
 * decimal (e.g. `XTCCH0001`). Alphanumeric only, on purpose (Worker→Container
 * contract) — a PDF text extractor can split a marker containing punctuation
 * across separate text-layer runs, but never a contiguous run of letters and
 * digits from a single inline span.
 */
export function formatChapterMarker(oneBasedIndex: number): string {
  return `XTCCH${String(oneBasedIndex).padStart(4, "0")}`;
}

/**
 * The literal marker span markup inserted immediately before a chapter's
 * heading (or, for split-safety — see src/aozora.ts's doc comment — as the
 * heading element's own first child, which reads identically in the
 * rendered PDF's linear text stream). `marker` is always a
 * formatChapterMarker() output, never document-derived text, so no escaping
 * is needed here. `aria-hidden="true"` keeps a screen reader from announcing
 * it in a live DOM view (see XTC_CHAPTER_MARKER_CSS's doc comment for why
 * this, together with that constant's `user-select: none`, never affects
 * Chromium's PDF text layer).
 */
export function renderChapterMarkerHtml(marker: string): string {
  return `<span class="${XTC_CHAPTER_MARKER_CLASS}" aria-hidden="true">${marker}</span>`;
}

/**
 * Normalizes a chapter's extracted heading text into the single-line,
 * single-spaced form src/container.ts's X-Xtc-Chapters contract requires:
 * every run of whitespace (including embedded newlines — AozoraInline `text`
 * nodes may contain them, types.ts's doc comment) collapses to one
 * half-width space, then the result is trimmed. The Container independently
 * truncates to UTF-8 80 bytes, so this function does not. Callers (both
 * render-html.ts's extractChapters and src/aozora.ts's insertChapterMarkers)
 * treat a name that normalizes to "" as "not a chapter" and drop it entirely
 * — an empty {name: "", marker: ...} entry would otherwise reach the
 * Container and the device's chapter list as a nameless, unselectable-looking
 * row.
 */
export function normalizeChapterName(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
