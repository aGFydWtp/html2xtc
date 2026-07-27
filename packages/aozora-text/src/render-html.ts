// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { formatChapterMarker, normalizeChapterName, renderChapterMarkerHtml } from "./chapters";
import type { XtcChapter } from "./chapters";
import type { AozoraBlock, AozoraDocument, AozoraInline } from "./types";

/**
 * Allowlist HTML renderer for the Aozora AST (spec §9/§11). This is the
 * ONLY place in the whole feature that turns document-derived strings into
 * HTML tags: every tag and attribute emitted here comes from a fixed
 * literal set chosen by this code, never from the input. Every piece of
 * input-derived text (text values, ruby base/reading, gaiji description,
 * raw-annotation text) is escaped individually via `escapeHtml` — never
 * concatenated with another input-derived string before escaping (spec
 * §9.1's ruby base/reading independence requirement generalizes to every
 * node type here).
 *
 * Allowed tags (spec §11.2): p, br, h2, h3, h4, ruby, rb, rt, rp, span, em,
 * strong, div. Allowed attributes (spec §11.3): class, aria-hidden, title.
 * No other tag or attribute is ever written by this file — grep for `<` in
 * this file to audit the full set. The one exception to "input-derived text
 * only" above is the chapter-marker span a chapter-level heading gets
 * prepended with (renderChapterMarkerHtml, ./chapters.ts; see
 * determineChapterHeadingLevel below for which level that is): its content
 * is always a formatChapterMarker() output (XTCCH + 4 digits), never
 * anything derived from the document.
 */

/** Mandatory HTML-escaping — the sole defense against document-derived text
 * being interpreted as markup (mirrors src/text-html.ts's escapeHtml; kept
 * as an independent copy here because this package must not depend on
 * backend code). */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A `text` node's value may contain embedded newlines (spec §10.2: aozora
 * normalization does not join hard-wrapped lines, so every line break in
 * the source is meaningful) — rendered as `<br>`, exactly like plain TXT's
 * textToParagraphHtml. */
function renderTextValue(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

type EmphasisStyle = Extract<AozoraInline, { type: "emphasis" }>["style"];

const EMPHASIS_CLASS: Record<EmphasisStyle, string> = {
  sesame: "sesame_dot",
  "white-sesame": "white_sesame_dot",
  "black-circle": "black_circle",
  "white-circle": "white_circle",
  "black-triangle": "black_up-pointing_triangle",
  "white-triangle": "white_up-pointing_triangle",
  bullseye: "bullseye",
  fisheye: "fisheye",
  saltire: "saltire",
};

function renderInline(node: AozoraInline): string {
  switch (node.type) {
    case "text":
      return renderTextValue(node.value);
    case "ruby": {
      // base and reading are escaped completely independently (spec §9.1's
      // security note) — reading never flows through renderInlineChildren,
      // and base's rendered markup never gets treated as a string to
      // re-escape.
      const base = renderInlineChildren(node.base);
      const reading = escapeHtml(node.reading);
      return `<ruby><rb>${base}</rb><rp>（</rp><rt>${reading}</rt><rp>）</rp></ruby>`;
    }
    case "emphasis": {
      const cls = EMPHASIS_CLASS[node.style];
      return `<em class="${cls}">${renderInlineChildren(node.children)}</em>`;
    }
    case "decoration": {
      const children = renderInlineChildren(node.children);
      if (node.style === "underline") {
        return `<span class="underline_solid">${children}</span>`;
      }
      if (node.style === "overline") {
        return `<span class="overline_solid">${children}</span>`;
      }
      if (node.style === "bold") {
        return `<strong>${children}</strong>`;
      }
      return `<em class="shatai">${children}</em>`; // italic
    }
    case "tcy":
      return `<span class="tcy">${renderInlineChildren(node.children)}</span>`;
    case "gaiji":
      if (node.unicode !== undefined) {
        // Already resolved to a real character during parsing (spec
        // §9.10) — render as ordinary escaped text, no wrapper needed.
        return escapeHtml(node.unicode);
      }
      return `<span class="gaiji-fallback" title="${escapeHtml(node.description)}">〓</span>`;
    case "rawAnnotation":
      return `<span class="aozora-raw-note">${escapeHtml(node.text)}</span>`;
  }
}

function renderInlineChildren(children: AozoraInline[]): string {
  return children.map(renderInline).join("");
}

/** Selects the spec §9.6/§9.7 class for a paragraph, per the
 * `indentEm`/`align` contract documented on AozoraBlock's `paragraph`
 * variant (types.ts). Returns undefined when no class applies. */
function paragraphClassName(block: Extract<AozoraBlock, { type: "paragraph" }>): string | undefined {
  if (block.align === "center") {
    return "aozora-center";
  }
  if (block.align === "end") {
    const n = block.indentEm ?? 0;
    return n > 0 ? `chitsuki_${n}` : "chitsuki_0";
  }
  if (block.indentEm !== undefined && block.indentEm > 0) {
    return `jisage_${block.indentEm}`;
  }
  return undefined;
}

const HEADING_TAG: Record<1 | 2 | 3, "h2" | "h3" | "h4"> = { 1: "h2", 2: "h3", 3: "h4" };
const HEADING_SIZE_CLASS: Record<1 | 2 | 3, string> = {
  1: "aozora-heading-large",
  2: "aozora-heading-medium",
  3: "aozora-heading-small",
};

/**
 * `chapterMarker`, when given, is prepended as the heading's OWN FIRST
 * CHILD (never as a preceding sibling) — this is what renderDocumentToHtml
 * passes for every heading at the document's chosen chapter level (see
 * determineChapterHeadingLevel below). Nesting the marker inside the
 * heading element, rather than placing it just before it, is deliberate:
 * only `renderBibliographyToHtml` (below) ever calls this function with no
 * marker, but the URL-extraction path (src/aozora.ts) shares this exact
 * placement convention for a concrete reason — the Aozora 4-chunk timeout
 * fallback (src/aozora-fallback/split.ts) splits a document's DOM at
 * top-level segment boundaries, and a bare sibling span could end up
 * separated from its heading by a chunk boundary. A marker nested INSIDE the
 * heading element stays part of the same segment as the heading in the
 * overwhelmingly common case (split.ts's flattenSegments classifies a whole
 * element, descendants included, as one atomic unit) — but NOT always:
 * flattenSegments recurses into (expands) a child whose own text exceeds
 * DOMINANT_FRACTION (40%) of the document's total text AND has more than one
 * child node, and once expanded, our marker span becomes its own
 * `isHeading: false` segment, no longer guaranteed to land in the same chunk
 * as the heading text it was meant to mark. This requires a single heading
 * to hold on its own more than 40% of the ENTIRE document's text, which is
 * exceedingly unlikely for a real heading (a short title, by nature) —
 * unreachable in every real Aozora document seen so far — but is not
 * literally impossible, so this is a best-effort placement, not a
 * mathematical guarantee. Were it to happen, the practical consequence is
 * narrow: the marker would land on a different page than its heading, so
 * the Container would resolve that one chapter's start page off by however
 * many pages separate the two — every other chapter is unaffected. No
 * additional guard is added here for this: doing so would mean complicating
 * split.ts's existing boundary logic for a case that has not been observed
 * in practice.
 */
function renderBlock(block: AozoraBlock, chapterMarker?: string): string {
  switch (block.type) {
    case "paragraph": {
      const cls = paragraphClassName(block);
      const classAttr = cls !== undefined ? ` class="${cls}"` : "";
      return `<p${classAttr}>${renderInlineChildren(block.children)}</p>`;
    }
    case "heading": {
      const tag = HEADING_TAG[block.level];
      const classes = ["aozora-heading", HEADING_SIZE_CLASS[block.level]];
      if (block.variant === "inline") {
        classes.push("aozora-heading-inline");
      } else if (block.variant === "window") {
        classes.push("aozora-heading-window");
      }
      const markerHtml = chapterMarker !== undefined ? renderChapterMarkerHtml(chapterMarker) : "";
      return `<${tag} class="${classes.join(" ")}">${markerHtml}${renderInlineChildren(block.children)}</${tag}>`;
    }
    case "pageBreak":
      return `<div class="aozora-page-break" aria-hidden="true"></div>`;
    case "rawAnnotation":
      return `<p><span class="aozora-raw-note">${escapeHtml(block.text)}</span></p>`;
  }
}

/**
 * Chooses which heading level this document's chapters come from (measured
 * data behind this rule: a random sample of 800 published Aozora works found
 * that among long-form works (≥100k characters) with ANY 大見出し, every
 * single one ALSO used 中見出し — 大のみ was 0.0% at that length — while 57%
 * of long-form works used 中見出し with NO 大見出し at all; treating 大見出し
 * as the only chapter source would leave the majority of this project's main
 * target audience — long-form works — with zero chapters):
 *
 *   - if the document has at least one level-1 (大見出し) heading anywhere,
 *     level 1 is the chapter level for the WHOLE document;
 *   - otherwise, if it has at least one level-2 (中見出し) heading, level 2
 *     is the chapter level;
 *   - otherwise there is no chapter level (null) — matches document-wide
 *     "大 xor 中, never both, never level 3" (小見出し is never a chapter
 *     source, regardless of what else is present).
 *
 * Never mixed: a document that has both 大 and 中 headings numbers ONLY the
 * 大 ones (中 stays plain, unmarked) — 大 conventionally means a bigger
 * division ("篇") that already CONTAINS 中 ("章") in the works that use
 * both, so 中 in that case is not this document's chapter granularity.
 * Exported (not just used internally by renderDocumentToHtml/extractChapters
 * below) so a caller can log/inspect which level a document resolved to —
 * src/text-prepare.ts's prepareAozora does exactly this via
 * PreparedTextDocument.chapterHeadingLevel.
 */
export function determineChapterHeadingLevel(document: AozoraDocument): 1 | 2 | null {
  let hasLevel1 = false;
  let hasLevel2 = false;
  for (const block of document.blocks) {
    if (block.type !== "heading") {
      continue;
    }
    if (block.level === 1) {
      hasLevel1 = true;
      break; // level 1 wins outright; no need to keep scanning for level 2
    }
    if (block.level === 2) {
      hasLevel2 = true;
    }
  }
  if (hasLevel1) {
    return 1;
  }
  return hasLevel2 ? 2 : null;
}

/** True once a heading's chapter name (headingPlainText + normalizeChapterName)
 * would be non-empty — shared by renderDocumentToHtml (below, to decide
 * whether to embed a marker at all) and extractChapters (to decide whether
 * to list it), so the two never disagree about which headings count. A
 * heading with no recognizable text (empty children, an empty ruby base, or
 * ONLY a rawAnnotation — headingPlainText excludes annotation notation
 * outright) must never produce a numbered-but-nameless chapter entry. */
function headingHasChapterName(children: AozoraInline[]): boolean {
  return normalizeChapterName(headingPlainText(children)).length > 0;
}

/**
 * Groups consecutive `boxed` `paragraph` blocks (罫囲み range, spec §9 —
 * `paragraph.boxed`, types.ts) into one shared `<div class="aozora-box">`
 * wrapper — grouping is a rendering-only concern layered on top of the flat
 * AST (types.ts's `AozoraBlock` deliberately stays non-recursive), so it has
 * to happen here rather than in the parser. Deliberately does NOT try to
 * infer table columns from the boxed content (spec: full-width-space-
 * separated text stays plain text inside the box, not a `<table>` — see
 * types.ts's `boxed` doc comment) — every member paragraph is rendered
 * exactly as `renderOne` would render it standalone (own jisage_N/
 * chitsuki_N/aozora-center class if any, plus a chapter marker if it's the
 * (impossible, since boxed only ever applies to `paragraph` blocks, never
 * `heading`) chapter heading); only the outer wrapper is new. One `<div>`
 * per *maximal* run of consecutive boxed paragraphs — a non-boxed block (or
 * a `heading`/`pageBreak`/`rawAnnotation` block, none of which can carry
 * `boxed`) always ends the current run, so three separately-typed
 * paragraphs never collapse into fewer boxes than the source had ranges,
 * and a single multi-paragraph range never gets split into several boxes
 * just because it spans more than one AozoraBlock.
 *
 * A `heading` or `pageBreak` interrupting an *otherwise still-open* 罫囲み
 * range (parse-document.ts never closes the range for these — only a
 * matching ここで罫囲み終わり does, spec §9's range semantics apply
 * uniformly regardless of what's inside) therefore always splits that one
 * range into two separate `<div class="aozora-box">` wrappers here, one on
 * each side of the interrupting block. This is intentional, not an
 * oversight: 罫囲み is a same-page visual frame (spec §9's ruled box), and
 * a single `<div>` spanning a page break or a heading would not mean
 * anything as one printed frame even if the markup allowed it — splitting
 * at the natural page/section boundary is the only rendering that makes
 * sense here. No diagnostic is raised for this case (unlike an actually
 * malformed range) — the range itself is still perfectly well-formed
 * Aozora notation, and every member paragraph keeps `boxed: true` exactly
 * as parsed; only the *rendering* naturally divides into two frames, which
 * is not a state worth warning about. */
function renderBlocksWithBoxes(blocks: AozoraBlock[], renderOne: (block: AozoraBlock) => string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "paragraph" && block.boxed === true) {
      const inner: string[] = [];
      while (i < blocks.length) {
        const candidate = blocks[i];
        if (candidate.type !== "paragraph" || candidate.boxed !== true) break;
        inner.push(renderOne(candidate));
        i++;
      }
      parts.push(`<div class="aozora-box">\n${inner.join("\n")}\n</div>`);
      continue;
    }
    parts.push(renderOne(block));
    i++;
  }
  return parts;
}

/** Renders the document body (spec §9) — NOT the 底本 bibliography, which
 * has its own renderer below so callers can place it on a separate page.
 * Every heading at the document's chosen chapter level
 * (determineChapterHeadingLevel above) that resolves to a non-empty name
 * (headingHasChapterName) gets a chapter-marker span, numbered in document
 * order starting at 1 (formatChapterMarker) — see renderBlock's doc comment
 * for exactly where the marker lands. extractChapters (below) walks the same
 * blocks with the same level/name-emptiness predicate, so its {name, marker}
 * pairs are guaranteed to line up with the markers embedded here. */
export function renderDocumentToHtml(document: AozoraDocument): string {
  const chapterLevel = determineChapterHeadingLevel(document);
  let chapterIndex = 0;
  const renderOne = (block: AozoraBlock): string => {
    if (
      block.type === "heading" &&
      block.level === chapterLevel &&
      headingHasChapterName(block.children)
    ) {
      chapterIndex++;
      return renderBlock(block, formatChapterMarker(chapterIndex));
    }
    return renderBlock(block);
  };
  return renderBlocksWithBoxes(document.blocks, renderOne).join("\n");
}

/** Plain text of a heading's children for the XTC chapter name (spec: no
 * ruby reading, no annotation notation — a "readable string"). Deliberately
 * a separate walk from extractPlainText (which is font-subsetting input and
 * wants every glyph, ruby readings included): a ruby reading is furigana
 * pronunciation guidance, not part of the title itself, and a rawAnnotation
 * node's text IS literal bracket notation (spec §4.3's fail-soft verbatim
 * keep) — both would corrupt a chapter name that is supposed to be exactly
 * what a reader would recognize as the heading's own words. */
function headingPlainText(children: AozoraInline[]): string {
  const parts: string[] = [];
  function visit(node: AozoraInline): void {
    switch (node.type) {
      case "text":
        parts.push(node.value);
        return;
      case "ruby":
        for (const child of node.base) visit(child);
        return;
      case "emphasis":
      case "decoration":
      case "tcy":
        for (const child of node.children) visit(child);
        return;
      case "gaiji":
        parts.push(node.unicode ?? node.description);
        return;
      case "rawAnnotation":
        return;
    }
  }
  for (const child of children) visit(child);
  return parts.join("");
}

/**
 * Return type of extractChapters below: the extracted chapter list paired
 * with which heading level actually produced it. Exists so a caller that
 * also needs the level (src/text-prepare.ts's prepareAozora, which threads
 * it into PreparedTextDocument.chapterHeadingLevel for observability) reads
 * it straight off this ONE call, instead of separately calling
 * determineChapterHeadingLevel over the same document a second time — two
 * independent call sites computing what is supposed to be the same answer
 * is exactly the kind of thing that silently drifts apart if only one side
 * is ever touched later. Mirrors src/aozora.ts's
 * AozoraChapterExtractionResult, the URL-path equivalent of this same
 * pairing.
 */
export interface ExtractChaptersResult {
  chapters: XtcChapter[];
  /** Same value determineChapterHeadingLevel(document) would return for
   * this document — 1 = 大見出し was used, 2 = 中見出し was used (大見出し
   * absent), null = neither present, so `chapters` is empty. */
  headingLevel: 1 | 2 | null;
}

/**
 * Extracts the XTC chapter list (spec: {name, marker}[], Worker→Container
 * contract in src/container.ts) from every heading at the document's chosen
 * chapter level (determineChapterHeadingLevel above) whose name is non-empty
 * (headingHasChapterName) in `document.blocks`, in document order — never
 * from `document.bibliography`, which renderDocumentToHtml/renderBlock never
 * number either, and never level 3 (小見出し), which is never a chapter
 * source regardless of what levels are present. `chapters` is [] outright
 * when the document has neither a 大見出し nor a 中見出し (`headingLevel`
 * null in that case too). A heading whose name normalizes to empty is
 * skipped entirely — not numbered, not listed — so the numbering here stays
 * exactly in step with renderDocumentToHtml's marker embedding (both apply
 * the identical level + name-emptiness predicate over the same array in the
 * same order).
 */
export function extractChapters(document: AozoraDocument): ExtractChaptersResult {
  const chapterLevel = determineChapterHeadingLevel(document);
  if (chapterLevel === null) {
    return { chapters: [], headingLevel: null };
  }
  const chapters: XtcChapter[] = [];
  let chapterIndex = 0;
  for (const block of document.blocks) {
    if (block.type !== "heading" || block.level !== chapterLevel) {
      continue;
    }
    const name = normalizeChapterName(headingPlainText(block.children));
    if (name.length === 0) {
      continue;
    }
    chapterIndex++;
    chapters.push({ name, marker: formatChapterMarker(chapterIndex) });
  }
  return { chapters, headingLevel: chapterLevel };
}

/** Renders the 底本 (source-edition) bibliography blocks, wrapped in the
 * shared `.bibliographical_information` class (spec §8.4/§12.2) so it
 * breaks onto its own page like the URL-extraction path's colophon. Returns
 * "" when there is nothing to show. */
export function renderBibliographyToHtml(bibliography: AozoraBlock[]): string {
  if (bibliography.length === 0) {
    return "";
  }
  return `<div class="bibliographical_information">\n${renderBlocksWithBoxes(bibliography, (block) => renderBlock(block)).join("\n")}\n</div>`;
}

/** Flattens every piece of user-visible text in the document (paragraph/
 * heading text, ruby base and reading, gaiji description/resolved
 * character) into one string, for font-subsetting purposes
 * (src/text-prepare.ts's searchableText / spec §12's inlined-font-subset
 * input) — deliberately NOT HTML, and NOT run through escapeHtml. */
export function extractPlainText(document: AozoraDocument): string {
  const parts: string[] = [];
  function visitInline(node: AozoraInline): void {
    switch (node.type) {
      case "text":
        parts.push(node.value);
        return;
      case "ruby":
        for (const child of node.base) visitInline(child);
        parts.push(node.reading);
        return;
      case "emphasis":
      case "decoration":
      case "tcy":
        for (const child of node.children) visitInline(child);
        return;
      case "gaiji":
        parts.push(node.unicode ?? node.description);
        return;
      case "rawAnnotation":
        parts.push(node.text);
        return;
    }
  }
  function visitBlock(block: AozoraBlock): void {
    switch (block.type) {
      case "paragraph":
      case "heading":
        for (const child of block.children) visitInline(child);
        return;
      case "pageBreak":
        return;
      case "rawAnnotation":
        parts.push(block.text);
        return;
    }
  }
  for (const block of document.blocks) visitBlock(block);
  for (const block of document.bibliography) visitBlock(block);
  return parts.join("\n");
}
