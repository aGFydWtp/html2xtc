// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Public contract of @html2xtc/markdown-text (markdown-conversion spec §6.3
 * / §9 / §14). Pure TypeScript, no DOM/Node/Cloudflare/network dependency —
 * imported by relative path from the backend (src/text-prepare.ts) and, via
 * a tsconfig path + vite alias, the Svelte frontend preview, mirroring
 * @html2xtc/aozora-text's split.
 *
 * This package deliberately never imports the `markdown-it` npm package
 * itself (spec §6.3): each independent `npm ci` (root vs frontend/) would
 * otherwise be free to resolve a different copy, silently drifting behavior
 * between production and preview. Instead every markdown-it-shaped value
 * this package touches is described here as a minimal *structural* type —
 * just the fields/methods the parser/renderer/chapter code actually reads —
 * and the caller (src/text-prepare.ts, frontend) constructs the real
 * `markdown-it` instance and hands it in via createMarkdownConverter's
 * factory (converter.ts). A real `markdown-it` `Token`/`MarkdownIt` value
 * structurally satisfies these interfaces without any cast.
 */

import type { XtcChapter } from "../../aozora-text/src/chapters";

/**
 * Minimal structural view of a markdown-it `Token` (see markdown-it's own
 * `lib/token.mjs`) — only the fields renderer.ts/plain-text.ts/chapters.ts
 * ever read. Notably omits every `Token` method (`attrGet`, `attrIndex`,
 * ...) — nothing here calls them, all attribute reads walk `attrs`
 * directly, so a real `Token[]` is always assignable here without a cast.
 */
export interface MarkdownToken {
  type: string;
  tag: string;
  nesting: -1 | 0 | 1;
  level: number;
  content: string;
  markup: string;
  info: string;
  children: MarkdownToken[] | null;
  attrs: [string, string][] | null;
  hidden: boolean;
  block: boolean;
  meta: unknown;
}

/** Minimal structural view of a markdown-it instance — only the one method
 * this package ever calls (`.parse`, never `.render`/`.renderer`: spec
 * §16's "markdown-it の renderer を使わず、token 列を自分で走査して許可リ
 * スト HTML のみを生成する"). */
export interface MarkdownItLike {
  parse(src: string, env: Record<string, unknown>): MarkdownToken[];
}

/**
 * The exact `markdown-it` constructor options every caller (backend,
 * frontend) must pass verbatim (spec §6.2) — exported here once so the two
 * independent `new MarkdownIt(...)` call sites can never drift on any of
 * these six fields.
 */
export const MARKDOWN_IT_OPTIONS = {
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
  xhtmlOut: false,
  maxNesting: 50,
} as const;

/**
 * Ceiling this package enforces on every parsed token's own `.level` (spec
 * §14's "Markdown nesting: 50以下"). Deliberately a *separate* constant from
 * `MARKDOWN_IT_OPTIONS.maxNesting` even though both currently read 50: that
 * option only bounds markdown-it's own *block*-level recursion guards
 * (blockquote/list nesting) — it does NOT bound inline delimiter nesting
 * (emphasis/strong can still recurse arbitrarily deep for a small,
 * adversarial input, e.g. hundreds of nested `*`), so this package always
 * re-checks the ACTUAL resulting token nesting itself, post-parse
 * (converter.ts's measureComplexity), rather than trusting the option
 * alone. Keeping this as its own constant means a future change to one
 * never silently also changes the other.
 */
export const MARKDOWN_MAX_NESTING = 50;

/** Hard ceiling on total token count — every token in the top-level array
 * PLUS every token in every `children` array, recursively (spec §14). */
export const MAX_MARKDOWN_TOKENS = 500_000;

/**
 * Thrown when a parsed document exceeds MAX_MARKDOWN_TOKENS or
 * MARKDOWN_MAX_NESTING (spec §14/§21). Deterministic for the exact input —
 * callers (src/workflow.ts, src/preview/text-preview.ts) treat this as a
 * non-retryable failure, exactly like @html2xtc/aozora-text's
 * AozoraAstLimitExceededError. The message is a fixed, content-free string
 * on purpose (spec §14: "クライアントへ本文、見出し、URL、コード内容など
 * を含むエラー文字列を返さない") — never interpolate anything
 * document-derived into it.
 */
export class MarkdownComplexityLimitError extends Error {
  constructor() {
    super("Markdown document is too complex to convert");
    this.name = "MarkdownComplexityLimitError";
  }
}

/**
 * Everything a caller needs out of one `MarkdownConverter.parse()` call
 * (spec §9). `contentHtml` is the ONLY thing that becomes displayed markup;
 * every other field is metadata derived from the same parse.
 */
export interface ParsedMarkdownDocument {
  /** Safe, allowlist-only HTML fragment (renderer.ts) — never markdown-it's
   * own HTML renderer output, and never contains anything from `<script>`,
   * `<style>`, `<iframe>`, `href`, `src`, or any user-controlled attribute
   * (spec §16). */
  contentHtml: string;
  /** Rendered-content plain text (plain-text.ts): the characters a reader
   * would actually see once contentHtml is displayed — never raw Markdown
   * source, never syntax markers, never the chapter-marker strings embedded
   * in contentHtml. Used for empty-body detection, font subsetting, and
   * (future) search indexing (spec §13). */
  plainText: string;
  /** The first non-empty H1's normalized plain text, if the document has
   * one — a document-title candidate (spec §10.1), never itself re-inserted
   * as a duplicate in-body heading (spec §10.2, enforced by the caller). */
  firstH1?: string;
  /** XTC chapter/table-of-contents metadata, in document order — reuses
   * @html2xtc/aozora-text's XtcChapter shape/marker format/marker CSS
   * verbatim (spec §11: "章マーカーを複製しないこと"). */
  chapters: XtcChapter[];
  /** Which heading level `chapters` came from (1 = H1, 2 = H2, null =
   * neither present with a non-empty name) — observability only, exactly
   * like PreparedTextDocument.chapterHeadingLevel for the `aozora` branch. */
  chapterHeadingLevel: 1 | 2 | null;
  /** Total token count (recursive over every `children` array) — the same
   * number MAX_MARKDOWN_TOKENS is checked against; also logged standalone
   * (spec §20's tokenCount=). */
  tokenCount: number;
}

export interface MarkdownConverter {
  /**
   * Parses `source` (already normalized — see normalizeMarkdownSource in
   * the backend, or the frontend's equivalent) into a ParsedMarkdownDocument.
   * @throws MarkdownComplexityLimitError when the result exceeds
   * MAX_MARKDOWN_TOKENS or MARKDOWN_MAX_NESTING.
   */
  parse(source: string): ParsedMarkdownDocument;
}
