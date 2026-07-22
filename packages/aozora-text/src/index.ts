// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Public API of @html2xtc/aozora-text (spec §6.1). Pure TypeScript, no
 * DOM/Node/Cloudflare/network dependency — imported by relative path from
 * both the backend (src/text-prepare.ts) and, via a tsconfig path + vite
 * alias, the Svelte frontend preview. Nothing outside this file's exports
 * (plus types.ts's types) is part of the supported surface — internal
 * modules (tokenize/parse-inline/metadata) are implementation details that
 * may be freely restructured across PRs.
 */

export type {
  AozoraBlock,
  AozoraDiagnostic,
  AozoraDocument,
  AozoraInline,
} from "./types";
export {
  MAX_AST_NODES,
  MAX_ANNOTATION_CODEPOINTS,
  MAX_DIAGNOSTICS,
  MAX_RANGE_NESTING_DEPTH,
  MAX_RUBY_READING_CODEPOINTS,
} from "./types";

export { AozoraAstLimitExceededError, parseAozoraDocument } from "./parse-document";
export { parseInlineText } from "./parse-inline";
export type { ParseInlineOptions } from "./parse-inline";
export { tokenizeAozoraChunk, splitIntoParagraphChunks } from "./tokenize";
export type { AozoraToken, ParagraphChunk } from "./tokenize";
export { separateDocumentStructure } from "./metadata";
export type { DocumentStructure } from "./metadata";

export {
  extractPlainText,
  renderBibliographyToHtml,
  renderDocumentToHtml,
} from "./render-html";

export { countRecognizedAnnotations } from "./count";

export { AOZORA_DOCUMENT_CSS } from "./styles";

export { detectAozoraFormat } from "./detect";
export type { AozoraDetectionResult } from "./detect";
