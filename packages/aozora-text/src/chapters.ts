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
 * Renders the marker invisible in print/PDF output while keeping it in the
 * PDF text layer (opaque white text — `color: white` + `-webkit-text-fill-
 * color: white`, blended into the always-white printed page, `font-size:
 * 1px`), and ALSO invisible to a live DOM view — text selection and screen
 * readers — without touching any of those properties (`user-select: none` +
 * `aria-hidden="true"` on the span itself, renderChapterMarkerHtml below).
 * This second half matters because the AST-based TXT renderer's output is
 * not print-only: frontend/src/components/TextInputPanel.svelte renders the
 * exact same renderDocumentToHtml() output as a live, selectable preview
 * (`{@html aozoraBodyHtml}`), and injects this exact stylesheet there too —
 * without `user-select: none`, a user copying the preview's body text would
 * get a stray `XTCCH0001` before every chapter heading; without
 * `aria-hidden`, a screen reader would announce it.
 *
 * `!important` on every declaration here matters for a reason specific to
 * this shared constant: src/pdf.ts's buildPrintRules() (injected by
 * renderPdfFromHtml — the Aozora Bunko URL-extraction path, src/aozora.ts)
 * carries `body * { color: black !important; -webkit-text-fill-color: black
 * !important; }`, a blanket full-contrast rule for arbitrary scraped pages.
 * CSS resolves the `!important` tier BEFORE specificity: a normal
 * (non-`!important`) declaration on `.xtc-chapter-marker` — even though a
 * class selector is more specific than `body *`'s type-plus-universal
 * selector — always loses to that `!important` rule regardless of source
 * order or specificity, so a prior transparent-only version of this
 * constant was silently repainted opaque BLACK on the URL-extraction path
 * (see the alpha=0 finding below for why that accidentally kept it working
 * at all). Marking every declaration here `!important` too moves this rule
 * into the same importance tier, where `.xtc-chapter-marker`'s class
 * selector (specificity 0,1,0) legitimately outranks `body *` (0,0,1) and
 * wins. The AST-based TXT renderer and its self-styled PDF path
 * (renderSelfStyledHtmlPdf) never inject buildPrintRules() at all (see that
 * function's own doc comment), so `!important` is a no-op improvement there,
 * never a hazard.
 *
 * WHY WHITE, NOT TRANSPARENT — do not revert this without rereading this
 * paragraph. An earlier version of this constant used `color: transparent`
 * (alpha=0), reasoned to be "more surely invisible than any opaque color"
 * and measured to survive intact through a LOCAL headless Chrome's
 * print-to-PDF text layer (see the fuller Chrome-vs-Browser-Rendering note
 * a few lines below). That reasoning does not hold in production: this
 * service's actual PDF renderer is Cloudflare's Browser Rendering, a
 * different Chromium build reached only via the BROWSER binding, and an A/B
 * test run directly against the PRODUCTION binding found alpha=0 text of
 * any kind — `color: transparent` alone, combined with `-webkit-text-fill-
 * color: transparent`, at 1px or 14px, with or without `user-select: none`
 * — is dropped from the PDF text layer entirely there, while every opaque
 * color tested (default black, `white`, `rgba(255,255,255,1)`, even
 * `rgba(0,0,0,0.01)`) survived. `font-size` and `user-select` were both
 * ruled out as factors; alpha alone was the deciding variable. White was
 * chosen over another near-invisible opaque color (e.g. `rgba(0,0,0,0.01)`)
 * because every render path here always prints on a plain white page
 * (`pdfOptions.printBackground: false` in src/pdf.ts means Chromium never
 * paints ANY CSS background — the canvas is simply blank/white — so white
 * text blends into it regardless of what background color a document's own
 * CSS requests).
 *
 * IMPORTANT CAVEAT, also measured against the production BROWSER binding:
 * an opaque color requested here does NOT reach the PDF exactly as
 * specified. Cloudflare Browser Rendering's PDF export applies a fixed,
 * per-channel darkening to any sufficiently light opaque text color,
 * independent of font-size or which of `color`/`-webkit-text-fill-color`
 * carries it: `color: white` (255,255,255) is actually painted as
 * `#ababab` (171,171,171) in the exported PDF's text layer, not literal
 * white. Confirmed as a fixed per-channel `-84` shift, not a proportional
 * one, by sweeping several opaque input colors and reading each glyph's
 * actual fill color back out of the rendered PDF: 255→171, 240→156,
 * 224→140, 204→120, 153→69 (every pair differs by exactly 84). This is a
 * property of the renderer, not of anything this codebase controls, and
 * `white` remains the right choice specifically BECAUSE it is the lightest
 * possible opaque input — the highest input value (255) yields the
 * highest reachable output (171); any darker requested color only makes
 * the marker MORE visible, never less. Do not re-derive "closer to
 * invisible" reasoning from the requested CSS value alone — always check
 * the actually-painted color against the real binding.
 *
 * Whether this `#ababab` glyph produces any visible ink after the
 * Container's 1-bit e-ink dithering has been measured end-to-end: a PDF
 * rendered by the production BROWSER binding (same renderer as above) was
 * run through the actual Container pipeline (converter/app.py's
 * convert_pdf -> the xtctool subprocess, converter/config-x3.toml's real
 * values — `[pdf] resolution = 200`, `[xtg] threshold = 128, dither = true,
 * dither_strength = 0.8`, Floyd-Steinberg in xtctool/algo/dithering.py) and
 * the final 1-bit output was inspected at the marker's own coordinates. The
 * glyph's actual rendered grayscale there measured 225-253 (255 = white) —
 * lighter than the `#ababab` (171) figure above, because `font-size: 1px`
 * anti-aliases the already-tiny glyph down to roughly 25-35% pixel
 * coverage, which blends with the white page background and dilutes the
 * effective density further. That leaves 30-97 points of headroom under
 * the 128 threshold — enough that Floyd-Steinberg's diffused error never
 * reached it: the final 1-bit output at the marker's coordinates was 100%
 * white, 0 black pixels, in this test. (The only pixel differences measured
 * between a "with marker" and "without marker" render were ~10,500 pixels
 * of unrelated heading-text reflow — the marker span consumes a sliver of
 * line-box height, shifting everything below it, exactly as documented
 * above — split almost evenly between newly-black and newly-white pixels,
 * with the "with marker" render actually having 17 FEWER black pixels
 * overall than "without".)
 *
 * Two things to weigh before trusting this as a permanent guarantee:
 * - This was a minimal, controlled test page, not a real document — it has
 *   not been re-run against a dense, realistic document (many chapters,
 *   heavier surrounding text) where different anti-aliasing or dithering
 *   error accumulation is conceivable. A production `.xtc` fetched after
 *   deploy is the intended follow-up check, not yet done as of this
 *   writing.
 * - The 25-35% coverage that keeps this under threshold comes from
 *   `font-size: 1px` specifically. If a future change enlarges the marker's
 *   font-size (for any reason) or lengthens the marker string, glyph
 *   coverage rises back toward the `#ababab` (171) figure — well within
 *   striking distance of the 128 threshold — and this whole measurement
 *   needs re-doing. Do not assume the headroom above scales with font-size;
 *   re-measure.
 *
 * If a future engineer is tempted to go back to `color: transparent` for
 * "more surely invisible," re-run the A/B test against the actual BROWSER
 * binding first — a local Chrome pass alone is not sufficient evidence
 * (see below).
 *
 * Measured, not just reasoned about — but ONLY ONE of these two measurement
 * passes reflects this service's real renderer:
 *
 * 1. LOCAL headless Chrome (150.0.7871.182), used only to confirm every
 *    OTHER property here (`font-size: 1px`, `user-select: none`,
 *    `aria-hidden`) is layout/accessibility-only and does not itself gate
 *    text-layer survival: a 30-page vertical-writing document
 *    (`writing-mode: vertical-rl`, `@page { size: 528px 792px }`) was
 *    printed to PDF and its text layer inspected with PyMuPDF, both with
 *    the marker as `color: transparent; font-size: 1px` alone and with
 *    `user-select: none` + `aria-hidden="true"` added. The marker text
 *    survived in BOTH cases there — but this pass never exercised the
 *    production renderer, so it could not and did not catch the alpha=0
 *    drop documented above; do not treat a local-Chrome-only pass as
 *    sufficient confirmation of anything about text-layer survival on this
 *    service again.
 * 2. Cloudflare Browser Rendering (the actual BROWSER binding used in
 *    production) — see the WHY WHITE paragraph above; this is the pass that
 *    actually governs this constant's color choice.
 *
 * Both passes agreed on the box-collapsing alternatives, independent of
 * alpha or Chromium build: `display: none`, `visibility: hidden`,
 * `opacity: 0`, `font-size: 0`, and `width: 0`/`inline-size: 0` variants all
 * remove the marker from the text layer entirely, which is why none of them
 * is used here.
 *
 * The local-Chrome measurement also found the marker is NOT layout-free: as
 * an ordinary inline element it still takes up a sliver of line-box space,
 * shifting the heading's own glyphs by roughly 7.5px in the printed PDF
 * (about 6.75px with `user-select: none` added) — `font-size: 1px` does not
 * collapse to a true 1px advance, apparently because Chromium enforces its
 * own minimum rendered font size underneath it; the exact shift is
 * therefore not guaranteed stable across Chromium versions. Every page
 * break in that same 30-page document landed identically with and without
 * the marker, so this shift is confined to the heading's own line and never
 * propagates into pagination — and even if it someday did, the marker sits
 * on the exact same line as the heading it marks, so the Container's page
 * lookup for that chapter would still be correct.
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
  color: white !important;
  -webkit-text-fill-color: white !important;
  font-size: 1px !important;
  user-select: none !important;
  -webkit-user-select: none !important;
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
