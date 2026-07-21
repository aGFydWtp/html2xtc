// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Text normalization and size-limit validation for uploaded TXT files
 * (text-upload spec §7/§8). Pure string logic — no R2/Workflow imports — so
 * it stays unit-testable under plain vitest.
 */

// Spec §7 initial limits.
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_TEXT_CHARS = 2_000_000;
export const MAX_TEXT_LINES = 200_000;
export const MAX_LINE_CHARS = 100_000;
export const MAX_GENERATED_HTML_BYTES = 12 * 1024 * 1024; // 12 MiB

export class EmptyTextError extends Error {}
export class TextTooLongError extends Error {}
export class TooManyLinesError extends Error {}
export class LineTooLongError extends Error {}

/** Splits on any of LF, CRLF, or bare CR — independent of prior normalization. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Length in code points, not UTF-16 units (surrogate-pair safe). */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

export interface TextLimits {
  maxChars: number;
  maxLines: number;
  maxLineChars: number;
}

export const DEFAULT_TEXT_LIMITS: TextLimits = {
  maxChars: MAX_TEXT_CHARS,
  maxLines: MAX_TEXT_LINES,
  maxLineChars: MAX_LINE_CHARS,
};

/**
 * Validates decoded (but not-yet-normalized) text against spec §7's counting
 * limits, run BEFORE normalization per the prepare-text pipeline order (spec
 * §12.3): decode → binary check → count/limit validation → normalize → ...
 * Throws a specific error type per condition so the caller (Workflow) can
 * surface a condition-specific message (spec §19.1).
 */
export function validateTextLimits(text: string, limits: TextLimits = DEFAULT_TEXT_LIMITS): void {
  if (!/\S/.test(text)) {
    throw new EmptyTextError("decoded text is empty");
  }
  const charCount = codePointLength(text);
  if (charCount > limits.maxChars) {
    throw new TextTooLongError(`text has ${charCount} characters, over the ${limits.maxChars} limit`);
  }
  const lines = splitLines(text);
  if (lines.length > limits.maxLines) {
    throw new TooManyLinesError(`text has ${lines.length} lines, over the ${limits.maxLines} limit`);
  }
  for (const line of lines) {
    const lineLength = codePointLength(line);
    if (lineLength > limits.maxLineChars) {
      throw new LineTooLongError(
        `a line has ${lineLength} characters, over the ${limits.maxLineChars} limit`,
      );
    }
  }
}

// Control characters removed outright (spec §8.3): C0 range minus LF/TAB,
// plus VT/FF, plus the rest of C0 up to US, plus DEL. LF (0x0A) and TAB
// (0x09) are explicitly kept; CR (0x0D) is handled by line-ending
// normalization before this runs, so any CR reaching here is already gone.
function isRemovedControlChar(code: number): boolean {
  if (code === 0x0a || code === 0x09) {
    return false;
  }
  if (code <= 0x08) {
    return true;
  }
  if (code === 0x0b || code === 0x0c) {
    return true;
  }
  if (code >= 0x0e && code <= 0x1f) {
    return true;
  }
  return code === 0x7f;
}

/** CRLF and bare CR both become LF (spec §8.1). */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/**
 * Strips the control characters listed in spec §8.3, keeping LF and TAB.
 * Returns the removed count alongside the cleaned text — the text/chars
 * themselves are never logged (spec §8.3/§17), only the count.
 */
function stripControlChars(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isRemovedControlChar(code)) {
      removed++;
      continue;
    }
    out += ch;
  }
  return { text: out, removed };
}

/**
 * Collapses runs of blank lines (whitespace-only counts as blank, spec §8.4)
 * down to at most `maxConsecutiveBlankLines`.
 */
function collapseBlankLines(text: string, maxConsecutiveBlankLines: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    if (isBlank) {
      blankRun++;
      if (blankRun > maxConsecutiveBlankLines) {
        continue;
      }
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Strips trailing spaces/tabs from every line (spec §8.5, preserveSpaces=false). */
function trimTrailingLineWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

// --- Hard-wrapped line joining ---------------------------------------------
//
// Many Japanese-book TXT sources are fixed-width hard-wrapped (~40-50 chars
// per line, breaking mid-sentence). This heuristic re-joins those lines
// within a paragraph so they read as flowing prose instead of a <br> per
// source line. It must stay byte-for-byte identical to
// frontend/src/lib/text-normalize.ts's copy — the two implementations are
// deliberately duplicated (frontend can't import from src/) rather than
// shared.

/** A line ending in one of these keeps its break: it reads as a sentence or
 * quotation boundary, not a mid-sentence hard wrap. */
const SENTENCE_END_CHARS = new Set([
  "。", "！", "？", "…", "‥", "」", "』", "）", "】", "〕", "〉", "》", ".", "!", "?",
]);

/** A line starting with one of these keeps the break before it: it reads as
 * a new paragraph-style unit (indent or opening quote), not a wrapped
 * continuation. */
const PARAGRAPH_HEAD_MARKERS = new Set(["　", "\t", "「", "『", "（", "〈", "《", "【"]);

/** Characters where joining two lines needs an inserted space to avoid
 * mashing words together (Latin text); anything else (Japanese prose) joins
 * with no separator. */
const ASCII_JOIN_CHAR_RE = /^[A-Za-z0-9,;:)]$/;

function lastCodePoint(value: string): string {
  const chars = Array.from(value);
  return chars.length > 0 ? chars[chars.length - 1] : "";
}

function firstCodePoint(value: string): string {
  const chars = Array.from(value);
  return chars.length > 0 ? chars[0] : "";
}

/** Whether the break between adjacent lines A (before) and B (after) should
 * be kept as a <br> rather than joined. */
function shouldPreserveLineBreak(a: string, b: string): boolean {
  const aTrimmed = a.replace(/[ \t]+$/, "");
  if (aTrimmed.length === 0 || b.length === 0) {
    return true;
  }
  if (SENTENCE_END_CHARS.has(lastCodePoint(aTrimmed))) {
    return true;
  }
  if (PARAGRAPH_HEAD_MARKERS.has(firstCodePoint(b))) {
    return true;
  }
  return false;
}

/** The character inserted between A and B when they are joined. */
function lineJoinSeparator(a: string, b: string): string {
  const aTrimmed = a.replace(/[ \t]+$/, "");
  const lastChar = lastCodePoint(aTrimmed);
  const firstChar = firstCodePoint(b);
  return ASCII_JOIN_CHAR_RE.test(lastChar) && ASCII_JOIN_CHAR_RE.test(firstChar) ? " " : "";
}

/** Joins hard-wrapped lines within a single paragraph block (no blank
 * lines inside `paragraph`). */
function joinLinesInParagraph(paragraph: string): string {
  const lines = paragraph.split("\n");
  let result = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    if (shouldPreserveLineBreak(a, b)) {
      result += "\n" + b;
    } else {
      // A's trailing space/tab is always dropped at a join boundary, even
      // when preserveSpaces=true (that flag only protects whitespace that
      // survives as a real line break elsewhere).
      result = result.replace(/[ \t]+$/, "") + lineJoinSeparator(a, b) + b;
    }
  }
  return result;
}

/**
 * Joins hard-wrapped lines within each blank-line-delimited paragraph
 * (spec: TXT join-lines heuristic). Operates on already-normalized text
 * (line endings unified, control chars stripped, blank runs collapsed) and
 * must run before paragraph splitting / <br> conversion (text-html.ts's
 * textToParagraphHtml).
 */
export function joinWrappedLines(text: string): string {
  return text
    .split(/(\n{2,})/)
    .map((chunk, index) => (index % 2 === 0 ? joinLinesInParagraph(chunk) : chunk))
    .join("");
}

export interface NormalizeOptions {
  maxConsecutiveBlankLines: number;
  preserveSpaces: boolean;
  joinHardWrappedLines: boolean;
}

export interface NormalizeResult {
  text: string;
  /** Count only (spec §8.3/§17): the removed characters themselves are never logged. */
  controlCharsRemoved: number;
}

/**
 * Full normalization pipeline (spec §8): CRLF/CR → LF, control-character
 * removal, NFC (never NFKC — spec §8.2), consecutive-blank-line collapsing,
 * (when preserveSpaces is false) trailing-whitespace trimming per line, and
 * (when joinHardWrappedLines is true) hard-wrapped line joining. Runs
 * entirely before paragraph splitting / <br> conversion (text-html.ts).
 */
export function normalizeText(text: string, options: NormalizeOptions): NormalizeResult {
  const lfOnly = normalizeLineEndings(text);
  const { text: stripped, removed } = stripControlChars(lfOnly);
  const nfc = stripped.normalize("NFC");
  const collapsed = collapseBlankLines(nfc, options.maxConsecutiveBlankLines);
  const trimmed = options.preserveSpaces ? collapsed : trimTrailingLineWhitespace(collapsed);
  const final = options.joinHardWrappedLines ? joinWrappedLines(trimmed) : trimmed;
  return { text: final, controlCharsRemoved: removed };
}
