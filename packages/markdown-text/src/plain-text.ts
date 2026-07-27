// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Plain-text extraction (spec §13) — the characters a reader would actually
 * see once contentHtml (renderer.ts) is displayed, never raw Markdown
 * source and never a syntax marker. Shared by converter.ts (the document's
 * ParsedMarkdownDocument.plainText/firstH1) and chapters.ts (a heading's
 * chapter name) so "what counts as this node's text" is answered exactly
 * once.
 */

import type { MarkdownToken } from "./types";

/**
 * Walks one inline-level token list (an 'inline' or 'image' token's
 * `.children`) collecting only the text a reader would see: `text` and
 * `code_inline` content verbatim, a line break for `softbreak`/`hardbreak`,
 * and — recursively — an `image` token's own alt text. Every other token in
 * an inline list is a bare open/close marker (`strong_open`, `em_close`,
 * `link_open`, `s_close`, ...) that carries no text of its own: whatever it
 * wraps already appears as separate sibling tokens in this same list, so
 * this function does NOT recurse into anything except `image` (the one
 * inline token whose text lives only in a nested `children` array, never as
 * a sibling).
 *
 * Deliberately excludes link destinations (`link_open`'s `href` never
 * reaches this function at all — only the token list itself is walked) and
 * every syntax marker (`#`, `**`, backticks, ...) — those never become
 * tokens with `type === "text"` in the first place, markdown-it's parser
 * already strips them during inline parsing.
 */
export function extractInlineText(tokens: MarkdownToken[] | null | undefined): string {
  if (tokens === null || tokens === undefined) {
    return "";
  }
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "code_inline":
        out += token.content;
        break;
      case "softbreak":
      case "hardbreak":
        out += "\n";
        break;
      case "image":
        // The alt text lives only in the image token's own `children`
        // (its parsed inline content), never as a sibling of the image
        // token itself.
        out += extractInlineText(token.children);
        break;
      default:
        // Every other inline type is a bare open/close marker with no text
        // of its own (see this function's doc comment).
        break;
    }
  }
  return out;
}

/**
 * Extracts the full document's plain text (spec §13) by walking the
 * top-level block token array once: every block's own text lives either in
 * its immediately-following `inline` token (paragraphs, headings, table
 * cells — extractInlineText above) or, for `fence`/`code_block`, directly
 * on the token's own `content` (raw code, never re-parsed as Markdown).
 * List/blockquote/table *structure* tokens (`bullet_list_open`,
 * `blockquote_open`, `tr_open`, ...) contribute nothing themselves — the
 * text they contain already appears as its own `inline`/`fence`/
 * `code_block` token later in this same flat array, regardless of how
 * deeply nested it is (markdown-it expresses block nesting purely through
 * open/close pairs, not a tree — see chapters.ts's collectHeadings for the
 * same property applied to headings).
 *
 * Each contributing block's text is joined with a newline — good enough for
 * empty-body detection, font-subsetting, and (future) search; not intended
 * to reconstruct the original Markdown's exact spacing.
 */
export function extractDocumentPlainText(tokens: MarkdownToken[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.type === "inline") {
      const text = extractInlineText(token.children);
      if (text.length > 0) {
        parts.push(text);
      }
    } else if (token.type === "fence" || token.type === "code_block") {
      if (token.content.length > 0) {
        parts.push(token.content);
      }
    }
  }
  return parts.join("\n");
}
