// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Public API of @html2xtc/markdown-text (markdown-conversion spec §6.3).
 * Pure TypeScript, no DOM/Node/Cloudflare/network dependency — imported by
 * relative path from both the backend (src/text-prepare.ts) and, via a
 * tsconfig path + vite alias, the Svelte frontend preview, mirroring
 * @html2xtc/aozora-text/index.ts's own split. Nothing outside this file's
 * exports is part of the supported surface — renderer.ts/plain-text.ts/
 * chapters.ts's internals may be freely restructured across PRs.
 */

export type { MarkdownItLike, MarkdownToken } from "./types";
export type { ParsedMarkdownDocument, MarkdownConverter } from "./types";
export { MarkdownComplexityLimitError } from "./types";
export { MAX_MARKDOWN_TOKENS, MARKDOWN_MAX_NESTING, MARKDOWN_IT_OPTIONS } from "./types";

export { createMarkdownConverter } from "./converter";

export { MARKDOWN_DOCUMENT_CSS } from "./styles";
