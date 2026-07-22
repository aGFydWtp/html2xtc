// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import {
  countRecognizedAnnotations,
  extractPlainText,
  parseAozoraDocument,
} from "../packages/aozora-text/src/index";
import {
  buildAozoraContentHtml,
  buildPlainTextContentHtml,
  buildTextDocumentShell,
  resolveDocumentTitle,
} from "./text-html";
import { normalizeForAozora, normalizeText } from "./text-normalize";
import type { TextConvertOptions } from "./text-options";

/**
 * Single preparation entrypoint shared by production conversion
 * (src/workflow.ts's prepare-text step) and X3 preview
 * (src/preview/text-preview.ts) — aozora-text-conversion spec §6.3/§14.1's
 * "production and preview must run the same preparation" requirement. Both
 * callers are wired to this function; its `plain` output stays
 * byte-identical to the pre-existing
 * normalizeText→resolveDocumentTitle→buildTextArticleHtml sequence
 * (test/text-prepare.test.ts).
 */
export interface PreparedTextDocument {
  html: string;
  documentTitle: string;
  author: string;
  /** Plain-text form of the body, for font-subsetting (spec §12): the
   * characters actually rendered, not raw source bytes. */
  searchableText: string;
  characterCount: number;
  lineCount: number;
  /** Count only (spec §8.3/§17): the removed characters themselves are
   * never logged, only this count (src/workflow.ts's prepare-text step). */
  controlCharsRemoved: number;
  diagnostics: {
    recognizedAnnotations: number;
    unsupportedAnnotations: number;
    malformedAnnotations: number;
    truncatedDiagnostics: boolean;
  };
}

export interface PrepareTextDocumentInput {
  decodedText: string;
  filename: string;
  options: TextConvertOptions;
}

/** Length in code points, not UTF-16 units (matches every other
 * codePointLength copy in this codebase — src/text-options.ts,
 * src/text-normalize.ts). */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

function lineCountOf(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

const EMPTY_DIAGNOSTICS: PreparedTextDocument["diagnostics"] = {
  recognizedAnnotations: 0,
  unsupportedAnnotations: 0,
  malformedAnnotations: 0,
  truncatedDiagnostics: false,
};

/**
 * Priority chain shared by title and author resolution (spec §8.2):
 * explicit option value, then a format-extracted value, both trimmed. Does
 * NOT apply the filename/"Untitled" fallback — that belongs only to the
 * document title, via resolveDocumentTitle, once neither of these two
 * tiers produced anything.
 */
function resolveDisplayValue(optionValue: string, extractedValue: string | undefined): string {
  const trimmedOption = optionValue.trim();
  if (trimmedOption.length > 0) {
    return trimmedOption;
  }
  return (extractedValue ?? "").trim();
}

function preparePlain(input: PrepareTextDocumentInput): PreparedTextDocument {
  const { decodedText, filename, options } = input;
  const normalized = normalizeText(decodedText, {
    maxConsecutiveBlankLines: options.maxConsecutiveBlankLines,
    preserveSpaces: options.preserveSpaces,
    joinHardWrappedLines: options.joinHardWrappedLines,
  });
  const documentTitle = resolveDocumentTitle(options.title, filename);
  const contentHtml = buildPlainTextContentHtml(normalized.text);
  const html = buildTextDocumentShell({
    contentHtml,
    options,
    documentTitle,
    displayTitle: options.title,
    author: options.author,
  });

  return {
    html,
    documentTitle,
    author: options.author.trim(),
    searchableText: normalized.text,
    characterCount: codePointLength(normalized.text),
    lineCount: lineCountOf(normalized.text),
    controlCharsRemoved: normalized.controlCharsRemoved,
    diagnostics: EMPTY_DIAGNOSTICS,
  };
}

function prepareAozora(input: PrepareTextDocumentInput): PreparedTextDocument {
  const { decodedText, filename, options } = input;
  const normalized = normalizeForAozora(decodedText);
  const doc = parseAozoraDocument(normalized.text);

  const displayTitle = resolveDisplayValue(options.title, doc.title);
  const documentTitle = displayTitle.length > 0 ? displayTitle : resolveDocumentTitle("", filename);
  const author = resolveDisplayValue(options.author, doc.author);

  const contentHtml = buildAozoraContentHtml(doc);
  const html = buildTextDocumentShell({
    contentHtml,
    options,
    documentTitle,
    displayTitle,
    author,
  });

  let unsupportedAnnotations = 0;
  let malformedAnnotations = 0;
  for (const diagnostic of doc.diagnostics) {
    if (diagnostic.kind === "unsupported-annotation") {
      unsupportedAnnotations++;
    } else if (
      diagnostic.kind === "malformed-annotation" ||
      diagnostic.kind === "unmatched-end" ||
      diagnostic.kind === "unclosed-range" ||
      diagnostic.kind === "ruby-without-base"
    ) {
      malformedAnnotations++;
    }
  }

  const searchableText = extractPlainText(doc);

  return {
    html,
    documentTitle,
    author,
    searchableText,
    characterCount: codePointLength(normalized.text),
    lineCount: lineCountOf(normalized.text),
    controlCharsRemoved: normalized.controlCharsRemoved,
    diagnostics: {
      recognizedAnnotations: countRecognizedAnnotations(doc),
      unsupportedAnnotations,
      malformedAnnotations,
      truncatedDiagnostics: doc.diagnostics.length >= 200,
    },
  };
}

/**
 * Prepares a decoded TXT upload (or preview body) for HTML generation,
 * branching on `options.inputFormat` (spec §5.1). `plain` reproduces the
 * pre-existing normalizeText → resolveDocumentTitle → buildTextArticleHtml
 * pipeline exactly; `aozora` normalizes per spec §10.2's different order
 * (no blank-line collapsing / hard-wrap joining before parsing —
 * joinHardWrappedLines is ignored entirely, spec §10.3) and routes the body
 * through the shared @html2xtc/aozora-text AST parser/renderer.
 */
export function prepareTextDocument(input: PrepareTextDocumentInput): PreparedTextDocument {
  return input.options.inputFormat === "aozora" ? prepareAozora(input) : preparePlain(input);
}
