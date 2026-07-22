// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { decodeBase64Url } from "./base64url";
import { sanitizeFontFamily } from "./fonts";

/**
 * TXT upload conversion settings (text-upload spec §6). Mirrors
 * PdfConvertOptions/pdf-upload.ts's structure and validation stance: the API
 * never implicitly corrects an out-of-range value, it 400s (spec §6.4).
 */

export type TextEncoding = "auto" | "utf-8" | "shift_jis";
export type TextLayout = "horizontal" | "vertical";
export type TextAlign = "start" | "justify";
/**
 * Selects the TXT body parser (aozora-text-conversion spec §5.1). `"plain"`
 * (the default, including when the field is entirely absent — spec §5.3)
 * keeps every existing byte-identical behavior. `"aozora"` routes the body
 * through the shared @html2xtc/aozora-text AST parser/renderer instead
 * (src/text-prepare.ts's prepareTextDocument).
 */
export type TextInputFormat = "plain" | "aozora";

export interface TextConvertOptions {
  inputFormat: TextInputFormat;
  encoding: TextEncoding;
  layout: TextLayout;
  /** Google Fonts family name; validated by sanitizeFontFamily (src/fonts.ts). */
  font: string;
  /** CSS px. */
  fontSizePx: number;
  /** Unitless. */
  lineHeight: number;
  /** CSS em. */
  paragraphSpacingEm: number;
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  textAlign: TextAlign;
  maxConsecutiveBlankLines: number;
  preserveSpaces: boolean;
  /**
   * Joins hard-wrapped lines within a paragraph (text-normalize.ts's
   * joinWrappedLines heuristic) instead of keeping every single newline as
   * <br>. Many Japanese-book TXT sources are fixed-width hard-wrapped, so
   * this defaults to true.
   */
  joinHardWrappedLines: boolean;
  showPageNumbers: boolean;
  /** 100 chars max (code points). */
  title: string;
  /** 100 chars max (code points). */
  author: string;
}

/** Spec §6.2 (aozora-text-conversion spec §5.2 for inputFormat). */
export const DEFAULT_TEXT_OPTIONS: TextConvertOptions = {
  inputFormat: "plain",
  encoding: "auto",
  layout: "horizontal",
  font: "BIZ UDPGothic",
  fontSizePx: 18,
  lineHeight: 1.8,
  paragraphSpacingEm: 0.9,
  margins: {
    top: 36,
    right: 32,
    bottom: 40,
    left: 32,
  },
  textAlign: "start",
  maxConsecutiveBlankLines: 2,
  preserveSpaces: false,
  joinHardWrappedLines: true,
  showPageNumbers: false,
  title: "",
  author: "",
};

const MARGIN_SIDES = ["top", "right", "bottom", "left"] as const;

/** Longest title/author kept anywhere (spec §6.1's "100文字以内"). */
const MAX_TEXT_META_CHARS = 100;

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Counts by code point, not UTF-16 units (matches sanitizeTitle in src/jobs.ts). */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

export type TextOptionsResult =
  | { ok: true; options: TextConvertOptions }
  | { ok: false; error: string };

/**
 * Validates a decoded TextConvertOptions JSON value against spec §6.4.
 * Strict: out-of-range or wrong-typed fields are rejected outright, never
 * silently clamped or defaulted. Unknown extra properties are ignored.
 */
export function validateTextConvertOptions(value: unknown): TextOptionsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "text options must be a JSON object" };
  }
  const v = value as Record<string, unknown>;

  // Backward compatibility (aozora-text-conversion spec §5.3): an absent
  // inputFormat — every payload/header/preview request predating this
  // field — is treated as "plain", not rejected. A present-but-unknown
  // value is still a hard 400, like every other field here.
  const inputFormatRaw = v.inputFormat === undefined ? "plain" : v.inputFormat;
  if (inputFormatRaw !== "plain" && inputFormatRaw !== "aozora") {
    return { ok: false, error: "invalid inputFormat" };
  }
  const inputFormat = inputFormatRaw;

  if (v.encoding !== "auto" && v.encoding !== "utf-8" && v.encoding !== "shift_jis") {
    return { ok: false, error: "invalid encoding" };
  }
  const encoding = v.encoding;

  if (v.layout !== "horizontal" && v.layout !== "vertical") {
    return { ok: false, error: "invalid layout" };
  }
  const layout = v.layout;

  const font = sanitizeFontFamily(v.font);
  if (font === undefined) {
    return { ok: false, error: "invalid font" };
  }

  if (!isFiniteInRange(v.fontSizePx, 12, 32)) {
    return { ok: false, error: "invalid fontSizePx" };
  }
  const fontSizePx = v.fontSizePx;

  if (!isFiniteInRange(v.lineHeight, 1.2, 2.5)) {
    return { ok: false, error: "invalid lineHeight" };
  }
  const lineHeight = v.lineHeight;

  if (!isFiniteInRange(v.paragraphSpacingEm, 0, 3)) {
    return { ok: false, error: "invalid paragraphSpacingEm" };
  }
  const paragraphSpacingEm = v.paragraphSpacingEm;

  if (typeof v.margins !== "object" || v.margins === null || Array.isArray(v.margins)) {
    return { ok: false, error: "invalid margins" };
  }
  const marginsInput = v.margins as Record<string, unknown>;
  const margins = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of MARGIN_SIDES) {
    const sideValue = marginsInput[side];
    if (!isFiniteInRange(sideValue, 0, 120)) {
      return { ok: false, error: `invalid margins.${side}` };
    }
    margins[side] = sideValue;
  }

  if (v.textAlign !== "start" && v.textAlign !== "justify") {
    return { ok: false, error: "invalid textAlign" };
  }
  const textAlign = v.textAlign;

  if (
    typeof v.maxConsecutiveBlankLines !== "number" ||
    !Number.isInteger(v.maxConsecutiveBlankLines) ||
    v.maxConsecutiveBlankLines < 0 ||
    v.maxConsecutiveBlankLines > 5
  ) {
    return { ok: false, error: "invalid maxConsecutiveBlankLines" };
  }
  const maxConsecutiveBlankLines = v.maxConsecutiveBlankLines;

  if (typeof v.preserveSpaces !== "boolean") {
    return { ok: false, error: "invalid preserveSpaces" };
  }
  const preserveSpaces = v.preserveSpaces;

  // Backward compatibility: this field was added after the initial TXT
  // upload release, so a header/stored payload from before then omits it
  // entirely. Treat that absence as the default (true) — same stance as
  // decodeTextOptionsHeader treating a wholly-missing header as
  // DEFAULT_TEXT_OPTIONS — but a present-and-wrong-typed value is still a
  // hard rejection like every other field here.
  const joinHardWrappedLinesRaw = v.joinHardWrappedLines === undefined ? true : v.joinHardWrappedLines;
  if (typeof joinHardWrappedLinesRaw !== "boolean") {
    return { ok: false, error: "invalid joinHardWrappedLines" };
  }
  const joinHardWrappedLines = joinHardWrappedLinesRaw;

  if (typeof v.showPageNumbers !== "boolean") {
    return { ok: false, error: "invalid showPageNumbers" };
  }
  const showPageNumbers = v.showPageNumbers;

  if (typeof v.title !== "string" || codePointLength(v.title) > MAX_TEXT_META_CHARS) {
    return { ok: false, error: "invalid title" };
  }
  const title = v.title;

  if (typeof v.author !== "string" || codePointLength(v.author) > MAX_TEXT_META_CHARS) {
    return { ok: false, error: "invalid author" };
  }
  const author = v.author;

  return {
    ok: true,
    options: {
      inputFormat,
      encoding,
      layout,
      font,
      fontSizePx,
      lineHeight,
      paragraphSpacingEm,
      margins,
      textAlign,
      maxConsecutiveBlankLines,
      preserveSpaces,
      joinHardWrappedLines,
      showPageNumbers,
      title,
      author,
    },
  };
}

/**
 * Decodes + validates X-Text-Options (spec §11.5). A missing header falls
 * back to DEFAULT_TEXT_OPTIONS (mirrors decodePdfOptionsHeader's stance for
 * X-Pdf-Options); a present-but-invalid header is always a 400.
 */
export function decodeTextOptionsHeader(headerValue: string | null): TextOptionsResult {
  if (headerValue === null) {
    return { ok: true, options: DEFAULT_TEXT_OPTIONS };
  }
  const decoded = decodeBase64Url(headerValue);
  if (decoded === null) {
    return { ok: false, error: "X-Text-Options is not valid base64url UTF-8" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "X-Text-Options is not valid JSON" };
  }
  return validateTextConvertOptions(parsed);
}
