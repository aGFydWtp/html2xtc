// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Markdown heading → XTC chapter selection (spec §11). Every piece of the
 * actual chapter *representation* — the XtcChapter shape, the marker string
 * format/numbering, the marker HTML, the marker CSS, and heading-name
 * normalization — is reused verbatim from @html2xtc/aozora-text/chapters
 * (spec §11's explicit "既存の... を再利用すること" / "final instructions"'
 * "章マーカーを複製しないこと"). This module only adds the one thing that
 * IS Markdown-specific: which headings in a token stream become chapters.
 */

import {
  formatChapterMarker,
  normalizeChapterName,
  renderChapterMarkerHtml,
  type XtcChapter,
} from "../../aozora-text/src/chapters";
import type { MarkdownToken } from "./types";
import { extractInlineText } from "./plain-text";

export { formatChapterMarker, normalizeChapterName, renderChapterMarkerHtml };
export type { XtcChapter };

const HEADING_LEVEL_BY_TAG: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** One heading found anywhere in the document — inside a list item or
 * blockquote counts too, spec §11 does not restrict chapter headings to the
 * top level. `token` is the exact `heading_open` token object (identity,
 * not a copy) so buildChapterPlan below can key a Map off it and
 * renderer.ts can look markers up by the very token it is about to render. */
export interface MarkdownHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  token: MarkdownToken;
  /** Decoration-stripped, whitespace-collapsed heading text
   * (normalizeChapterName over extractInlineText) — "" for a heading with
   * no recognizable text (e.g. `#` alone, or one holding only an image). */
  name: string;
}

/**
 * Walks the top-level (block) token array collecting every heading as
 * {level, token, name}. A single flat pass suffices: markdown-it expresses
 * block nesting purely through open/close pairs in one flat array, never a
 * tree (children arrays exist only for 'inline'/'image' tokens) — so a
 * heading nested inside a list item or blockquote appears right there in
 * `tokens`, at whatever level, exactly like a top-level one. Every
 * `heading_open` is unconditionally immediately followed by exactly one
 * `inline` token holding that heading's parsed text (even when empty, e.g.
 * `#` alone still produces an `inline` token with an empty `children`
 * array) — verified against markdown-it 14.3.0's own heading rule, both ATX
 * and Setext forms, at any nesting depth.
 */
export function collectHeadings(tokens: MarkdownToken[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "heading_open") {
      continue;
    }
    const level = HEADING_LEVEL_BY_TAG[token.tag];
    if (level === undefined) {
      continue;
    }
    const inlineToken = tokens[i + 1];
    const children = inlineToken?.type === "inline" ? inlineToken.children : null;
    headings.push({ level, token, name: normalizeChapterName(extractInlineText(children)) });
  }
  return headings;
}

/**
 * Chapter-level selection rule (spec §11): a non-empty H1 anywhere makes
 * every non-empty H1 the chapter list; failing that, a non-empty H2 makes
 * every non-empty H2 the chapter list; failing that, no chapters. H3+ never
 * becomes a chapter regardless of whether H1/H2 exist. Mirrors
 * @html2xtc/aozora-text's determineChapterHeadingLevel decision shape, over
 * Markdown headings instead of an AozoraDocument's blocks.
 */
export function selectChapterHeadingLevel(headings: readonly MarkdownHeading[]): 1 | 2 | null {
  if (headings.some((heading) => heading.level === 1 && heading.name.length > 0)) {
    return 1;
  }
  if (headings.some((heading) => heading.level === 2 && heading.name.length > 0)) {
    return 2;
  }
  return null;
}

export interface ChapterPlan {
  /** {name, marker} pairs in document order — exactly the headings at
   * `chapterHeadingLevel` whose name is non-empty. */
  chapters: XtcChapter[];
  /** Which exact `heading_open` token (by object identity) gets a marker
   * embedded immediately before it, and what that marker string is —
   * renderer.ts looks a token up here as it renders each heading_open. */
  markerByToken: Map<MarkdownToken, string>;
}

/**
 * Builds the {name, marker} list AND the token→marker lookup renderer.ts
 * needs, from a single pass over `headings` — guaranteeing `chapters` and
 * the markers actually embedded in contentHtml can never drift apart in
 * count or order (spec §11: "chapters とHTML markerの数・順序が一致").
 */
export function buildChapterPlan(
  headings: readonly MarkdownHeading[],
  chapterHeadingLevel: 1 | 2 | null,
): ChapterPlan {
  const chapters: XtcChapter[] = [];
  const markerByToken = new Map<MarkdownToken, string>();
  if (chapterHeadingLevel === null) {
    return { chapters, markerByToken };
  }
  let index = 0;
  for (const heading of headings) {
    if (heading.level !== chapterHeadingLevel || heading.name.length === 0) {
      continue;
    }
    index++;
    const marker = formatChapterMarker(index);
    chapters.push({ name: heading.name, marker });
    markerByToken.set(heading.token, marker);
  }
  return { chapters, markerByToken };
}
