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

export interface NormalizeOptions {
  maxConsecutiveBlankLines: number;
  preserveSpaces: boolean;
}

export interface NormalizeResult {
  text: string;
  /** Count only (spec §8.3/§17): the removed characters themselves are never logged. */
  controlCharsRemoved: number;
}

/**
 * Full normalization pipeline (spec §8): CRLF/CR → LF, control-character
 * removal, NFC (never NFKC — spec §8.2), consecutive-blank-line collapsing,
 * and (when preserveSpaces is false) trailing-whitespace trimming per line.
 */
export function normalizeText(text: string, options: NormalizeOptions): NormalizeResult {
  const lfOnly = normalizeLineEndings(text);
  const { text: stripped, removed } = stripControlChars(lfOnly);
  const nfc = stripped.normalize("NFC");
  const collapsed = collapseBlankLines(nfc, options.maxConsecutiveBlankLines);
  const final = options.preserveSpaces ? collapsed : trimTrailingLineWhitespace(collapsed);
  return { text: final, controlCharsRemoved: removed };
}
