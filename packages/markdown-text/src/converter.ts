// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Ties parsing (an injected MarkdownItLike), complexity enforcement,
 * chapter selection, plain-text extraction, and safe HTML rendering
 * together into one MarkdownConverter (spec §6.3/§12).
 */

import { buildChapterPlan, collectHeadings, selectChapterHeadingLevel } from "./chapters";
import { extractDocumentPlainText } from "./plain-text";
import { renderTokensToHtml } from "./renderer";
import type { MarkdownConverter, MarkdownItLike, MarkdownToken, ParsedMarkdownDocument } from "./types";
import { MARKDOWN_MAX_NESTING, MAX_MARKDOWN_TOKENS, MarkdownComplexityLimitError } from "./types";

interface ComplexityMeasurement {
  totalTokens: number;
  maxLevel: number;
}

/**
 * Walks every token in `tokens` AND every token in every `children` array,
 * recursively, counting them all and tracking the highest `.level` seen
 * anywhere (spec §14's token-count and nesting ceilings). Reusing
 * markdown-it's own per-token `.level` — rather than re-deriving nesting
 * depth from `nesting` (+1/0/-1) here — matters for one specific reason:
 * `.level` already reflects INLINE delimiter nesting (emphasis/strong can
 * recurse arbitrarily deep for a tiny adversarial input, e.g. hundreds of
 * nested `*`, verified directly against markdown-it 14.3.0 — a 300-`*`
 * input yields token levels up to 150), which markdown-it's own
 * `maxNesting` option does NOT bound (that option only guards block-level
 * recursion — blockquote/list — see types.ts's MARKDOWN_MAX_NESTING doc
 * comment). This is the one and only place that boundary is enforced.
 */
function measureComplexity(tokens: MarkdownToken[]): ComplexityMeasurement {
  let totalTokens = 0;
  let maxLevel = 0;

  function walk(list: MarkdownToken[]): void {
    for (const token of list) {
      totalTokens++;
      if (token.level > maxLevel) {
        maxLevel = token.level;
      }
      if (token.children !== null) {
        walk(token.children);
      }
    }
  }

  walk(tokens);
  return { totalTokens, maxLevel };
}

/**
 * Builds a MarkdownConverter around a caller-supplied markdown-it instance
 * factory (spec §6.3): the factory runs once, immediately, and the
 * resulting instance is reused across every `.parse()` call — matching
 * markdown-it's own documented usage pattern (a `MarkdownIt` instance holds
 * only its rule configuration, not per-document state) and avoiding
 * reconstructing the parser (and its internal rule chains) on every
 * request.
 */
export function createMarkdownConverter(factory: () => MarkdownItLike): MarkdownConverter {
  const markdownIt = factory();

  return {
    parse(source: string): ParsedMarkdownDocument {
      const tokens = markdownIt.parse(source, {});

      const { totalTokens, maxLevel } = measureComplexity(tokens);
      if (totalTokens > MAX_MARKDOWN_TOKENS || maxLevel > MARKDOWN_MAX_NESTING) {
        throw new MarkdownComplexityLimitError();
      }

      const headings = collectHeadings(tokens);
      const chapterHeadingLevel = selectChapterHeadingLevel(headings);
      const { chapters, markerByToken } = buildChapterPlan(headings, chapterHeadingLevel);

      const contentHtml = renderTokensToHtml(tokens, markerByToken);
      const plainText = extractDocumentPlainText(tokens);
      const firstH1 = headings.find((heading) => heading.level === 1 && heading.name.length > 0)?.name;

      return {
        contentHtml,
        plainText,
        firstH1,
        chapters,
        chapterHeadingLevel,
        tokenCount: totalTokens,
      };
    },
  };
}
