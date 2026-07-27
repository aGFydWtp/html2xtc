// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Allowlist-only HTML renderer (spec §16 / final instructions: "Markdown本
 * 文を任意HTMLへ変換してから汎用サニタイザーへ通す設計ではなく、最初から
 * 許可リストのHTMLだけを生成すること"). Never uses markdown-it's own
 * `Renderer`/`.render()` — walks the token array markdown-it's `.parse()`
 * (types.ts's MarkdownItLike) produced and emits ONLY the tags/attributes
 * below, built entirely from fixed strings plus escaped text. There is no
 * code path here that can copy a user-supplied attribute name, attribute
 * value, `href`, `src`, `style`, `class`, `id`, or `on*` handler into the
 * output — the emitted tags carry either no attributes at all, or one of a
 * fixed, closed set (`ol[start]`'s validated integer, `.md-link`,
 * `.md-image-placeholder`, the chapter marker's own class/aria-hidden from
 * @html2xtc/aozora-text's renderChapterMarkerHtml).
 *
 * Allowed tags (spec §16): p h1-h6 em strong s ul ol li blockquote code pre
 * hr br table thead tbody tr th td span. Every markdown-it token type this
 * package's MARKDOWN_IT_OPTIONS (html:false, default preset) can ever
 * produce is switched on explicitly below; anything not recognized emits
 * nothing (see the bottom default case) rather than guessing.
 */

import { normalizeChapterName, renderChapterMarkerHtml } from "../../aozora-text/src/chapters";
import { extractInlineText } from "./plain-text";
import type { MarkdownToken } from "./types";

/** Mandatory HTML-escaping — independent copy (mirrors
 * @html2xtc/aozora-text/render-html.ts's own escapeHtml doc comment: this
 * package must not depend on backend code, and must not depend on
 * markdown-it's own escaping either). */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Block-level container token-type-prefix → allowed tag. `ordered_list` is
 * handled separately (needs the validated `start` attribute) — every other
 * entry here always renders with no attributes at all. */
const BLOCK_TAG: Readonly<Record<string, string>> = {
  paragraph: "p",
  bullet_list: "ul",
  list_item: "li",
  blockquote: "blockquote",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: "th",
  td: "td",
};

/** Inline-level container token-type-prefix → allowed tag. `link` becomes a
 * plain `<span class="md-link">` (spec §7.1: no `href` ever emitted, for
 * both a Markdown link and a CommonMark autolink — markdown-it represents
 * both as `link_open`/`link_close`, distinguished only by `markup ===
 * "autolink"`, which this renderer does not need to check: neither case
 * ever emits `href`). */
const INLINE_TAG: Readonly<Record<string, string>> = {
  strong: "strong",
  em: "em",
  s: "s",
  link: "span",
};

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Validates an `ordered_list_open` token's `start` attribute into a safe
 * non-negative integer, or `null` if absent/unparseable — never a raw
 * attribute value. markdown-it only ever emits a `start` attribute at all
 * when the list's first marker is not `1` (spec: "`ol[start]` の安全な整
 * 数値"). The declared MarkdownToken type says every attr value is a
 * `string`, but markdown-it 14.3.0 stores this specific one as a `number`
 * at runtime (verified directly against its own list rule) — `Number(...)`
 * handles both representations identically, so this never depends on which
 * one actually arrives.
 */
function safeOrderedListStart(attrs: MarkdownToken["attrs"]): number | null {
  if (attrs === null) {
    return null;
  }
  for (const [name, value] of attrs) {
    if (name !== "start") {
      continue;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Renders an `image` token as a text-only placeholder (spec §7.2): never an
 * `<img>`, never the image URL, only the alt text (if any), wrapped in
 * fixed bracket text and escaped. Alt text is extracted from the image
 * token's own nested `children` (its parsed inline content) — NOT
 * `token.content`, which holds the raw, un-escaped Markdown source of the
 * alt label (e.g. literal `**bold**`) rather than its rendered text.
 */
function renderImagePlaceholder(token: MarkdownToken): string {
  const alt = normalizeChapterName(extractInlineText(token.children));
  const label = alt.length > 0 ? `［画像: ${escapeHtml(alt)}］` : "［画像］";
  return `<span class="md-image-placeholder">${label}</span>`;
}

/**
 * Renders one token list — either the top-level block array from
 * `MarkdownItLike.parse()`, or an inline token's own `.children` (this
 * function calls itself for that case, via the `"inline"` branch below).
 * `markerByToken` (chapters.ts's ChapterPlan.markerByToken) supplies which
 * exact `heading_open` token objects get a chapter marker embedded
 * immediately before them, keyed by object identity so this never needs to
 * recompute chapter selection itself.
 */
function renderList(tokens: MarkdownToken[], markerByToken: ReadonlyMap<MarkdownToken, string>): string {
  let out = "";
  for (const token of tokens) {
    out += renderToken(token, markerByToken);
  }
  return out;
}

function renderToken(token: MarkdownToken, markerByToken: ReadonlyMap<MarkdownToken, string>): string {
  switch (token.type) {
    case "inline":
      return renderList(token.children ?? [], markerByToken);
    case "text":
      return escapeHtml(token.content);
    case "softbreak":
      // CommonMark soft-break rule (spec §7's "通常の空白または改行規則"):
      // a literal newline character, which ordinary (non-`pre`) HTML
      // white-space handling collapses to a single space when displayed —
      // exactly like markdown-it's own default renderer's softbreak output.
      return "\n";
    case "hardbreak":
      return "<br>";
    case "hr":
      return "<hr>";
    case "code_inline":
      return `<code>${escapeHtml(token.content)}</code>`;
    case "fence":
    case "code_block":
      // Raw code content, never re-parsed as Markdown or HTML — only
      // escaped. Fenced and indented code blocks render identically (spec
      // §7's table: both map to <pre><code>); the fence's language `info`
      // string is intentionally never emitted (no syntax highlighting in
      // MVP, spec §4).
      return `<pre><code>${escapeHtml(token.content)}</code></pre>`;
    case "image":
      return renderImagePlaceholder(token);
    case "heading_open": {
      if (!HEADING_TAGS.has(token.tag)) {
        return "";
      }
      const marker = markerByToken.get(token);
      const markerHtml = marker !== undefined ? renderChapterMarkerHtml(marker) : "";
      return `${markerHtml}<${token.tag}>`;
    }
    case "heading_close":
      return HEADING_TAGS.has(token.tag) ? `</${token.tag}>` : "";
    case "ordered_list_open": {
      const start = safeOrderedListStart(token.attrs);
      return start !== null ? `<ol start="${start}">` : "<ol>";
    }
    case "ordered_list_close":
      return "</ol>";
    default:
      break;
  }

  if (token.type.endsWith("_open")) {
    const base = token.type.slice(0, -"_open".length);
    const tag = BLOCK_TAG[base] ?? INLINE_TAG[base];
    if (tag === undefined) {
      return "";
    }
    return base === "link" ? '<span class="md-link">' : `<${tag}>`;
  }
  if (token.type.endsWith("_close")) {
    const base = token.type.slice(0, -"_close".length);
    const tag = BLOCK_TAG[base] ?? INLINE_TAG[base];
    return tag === undefined ? "" : `</${tag}>`;
  }

  // Unreachable with MARKDOWN_IT_OPTIONS (html:false + the default preset,
  // no plugins — spec §6.2's "任意プラグインを追加しない"): every token
  // type the parser can produce is handled explicitly above. Skipping
  // (rather than guessing at a tag) keeps this renderer's output allowlist
  // closed even if a future markdown-it upgrade ever adds a new rule this
  // file has not been updated for.
  return "";
}

/**
 * Renders a full parsed token array into a safe HTML fragment (spec §9's
 * ParsedMarkdownDocument.contentHtml). `markerByToken` is optional purely
 * for callers that have no chapters to embed (an empty map is equivalent).
 */
export function renderTokensToHtml(
  tokens: MarkdownToken[],
  markerByToken: ReadonlyMap<MarkdownToken, string> = new Map(),
): string {
  return renderList(tokens, markerByToken);
}
