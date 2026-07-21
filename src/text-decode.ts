// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import * as JapaneseEncoding from "encoding-japanese";
import type { TextEncoding } from "./text-options";

/**
 * Character-encoding detection/decoding for uploaded TXT files (text-upload
 * spec §5/§14). Deliberately does NOT rely on workerd's native
 * TextDecoder("shift_jis"): as of this writing that non-UTF-8 label sits
 * behind an in-progress compatibility flag with a known streaming-decode bug
 * (cloudflare/workerd#6193) and this project's wrangler.jsonc pins no such
 * flag. Shift_JIS/CP932 decoding goes through the encoding-japanese pure-JS
 * library instead (spec §10.1/§14.3) — the same library the frontend uses,
 * so client-side auto-detection and the server's independent re-validation
 * agree on the same bytes.
 */

/** Thrown when the input carries a UTF-16 BOM (spec §5.1: unsupported). */
export class Utf16NotSupportedError extends Error {}

/** Thrown when the input looks like a binary file (spec §14.4). */
export class BinaryTextFileError extends Error {}

/**
 * Thrown when neither UTF-8 nor Shift_JIS/CP932 produces a text the
 * confidence checks (spec §5.4) accept.
 */
export class EncodingDetectionFailedError extends Error {}

export interface DecodedText {
  text: string;
  encoding: "utf-8" | "shift_jis";
  confidence: "high" | "medium" | "low";
}

const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** True when the byte string starts with a UTF-16LE or UTF-16BE BOM. */
export function hasUtf16Bom(bytes: Uint8Array): boolean {
  return startsWith(bytes, UTF16LE_BOM) || startsWith(bytes, UTF16BE_BOM);
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return startsWith(bytes, UTF8_BOM);
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

// Only the first 64 KiB is inspected (spec §14.4): enough to catch a magic
// header or a binary file's control-byte density without paying for a full
// scan of a multi-MiB upload.
const BINARY_SNIFF_BYTES = 64 * 1024;

// Known binary magics to reject outright (spec §14.4/§5.4). Checked against
// the start of the file only.
const BINARY_MAGICS: number[][] = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP / docx / xlsx / epub / ...
  [0x50, 0x4b, 0x05, 0x06], // ZIP (empty archive)
  [0x50, 0x4b, 0x07, 0x08], // ZIP (spanned archive)
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF87a/GIF89a
];

/**
 * Binary-file heuristic (spec §14.4): a NUL byte anywhere in the sniffed
 * window, a recognized binary magic at the start, or an ASCII-control-byte
 * ratio over 5%. Only the ASCII C0 control range (plus DEL) counts toward
 * the ratio — Shift_JIS/CP932 trail bytes routinely fall in 0x40-0x7E which
 * overlaps printable ASCII, and lead bytes are >= 0x81, so multi-byte
 * Japanese text is never miscounted as control bytes.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, BINARY_SNIFF_BYTES);

  for (const magic of BINARY_MAGICS) {
    if (startsWith(window, magic)) {
      return true;
    }
  }

  let controlCount = 0;
  for (const byte of window) {
    if (byte === 0x00) {
      return true;
    }
    // LF/TAB/CR are legitimate line-ending bytes, not control noise.
    const isC0Control = byte < 0x20 && byte !== 0x0a && byte !== 0x09 && byte !== 0x0d;
    const isDel = byte === 0x7f;
    if (isC0Control || isDel) {
      controlCount++;
    }
  }
  if (window.length === 0) {
    return false;
  }
  return controlCount / window.length > 0.05;
}

/** Strict UTF-8 decode (BOM stripped); null on any invalid byte sequence. */
function tryDecodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    const withoutBom = hasUtf8Bom(bytes) ? bytes.subarray(UTF8_BOM.length) : bytes;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(withoutBom);
  } catch {
    return null;
  }
}

/**
 * CP932 (Windows-31J) decode via encoding-japanese (spec §14.3: Windows TXT
 * compatibility takes priority over strict JIS X 0208 Shift_JIS). Unmappable
 * byte sequences fall back to the library's replacement handling rather than
 * throwing — callers validate the result via replacementRatio.
 */
function decodeCp932(bytes: Uint8Array): string {
  return JapaneseEncoding.convert(bytes, {
    to: "UNICODE",
    from: "SJIS",
    type: "string",
  });
}

// U+FFFD REPLACEMENT CHARACTER: what a failed/unmappable decode surfaces as.
const REPLACEMENT_CHAR = "�";

/** Fraction of non-whitespace characters that are the replacement char. */
export function replacementRatio(text: string): number {
  const nonSpace = Array.from(text).filter((ch) => !/\s/.test(ch));
  if (nonSpace.length === 0) {
    return 0;
  }
  const replaced = nonSpace.filter((ch) => ch === REPLACEMENT_CHAR).length;
  return replaced / nonSpace.length;
}

// Spec §5.4: replacement-char ratio over non-whitespace chars must stay
// under 1%.
const MAX_REPLACEMENT_RATIO = 0.01;

function hasAnyUsableChar(text: string): boolean {
  return Array.from(text).some((ch) => !/\s/.test(ch));
}

/**
 * Decodes CP932 and validates it against spec §5.4's confidence gates.
 *
 * encoding-japanese's own convert() is deliberately permissive — unmappable
 * single bytes decode to "?" rather than throwing or emitting U+FFFD, so a
 * bare replacement-char-ratio check on its OUTPUT rarely fires even for
 * genuine garbage (verified empirically: 200 bytes of undefined SJIS lead
 * bytes like 0x80/0xA0/0xFD-0xFF decode with zero U+FFFD in the result).
 * Encoding.detect(bytes, "SJIS") runs the library's own structural byte-
 * pattern heuristic BEFORE conversion and reliably tells real Shift_JIS/
 * CP932 apart from noise, so it is the primary gate here; the replacement-
 * ratio check (spec §5.4's literal wording) stays as a cheap secondary gate
 * for the (rarer) case where conversion itself does emit U+FFFD.
 */
function decodeCp932WithValidation(bytes: Uint8Array): DecodedText {
  if (!JapaneseEncoding.detect(bytes, "SJIS")) {
    throw new EncodingDetectionFailedError("bytes do not look like Shift_JIS/CP932");
  }
  const text = decodeCp932(bytes);
  if (!hasAnyUsableChar(text)) {
    throw new EncodingDetectionFailedError("decoded text has no usable characters");
  }
  const ratio = replacementRatio(text);
  if (ratio > MAX_REPLACEMENT_RATIO) {
    throw new EncodingDetectionFailedError(
      `replacement-character ratio ${ratio.toFixed(4)} exceeds the ${MAX_REPLACEMENT_RATIO} threshold`,
    );
  }
  return { text, encoding: "shift_jis", confidence: ratio === 0 ? "high" : "medium" };
}

/**
 * Decodes an uploaded TXT file's raw bytes per the requested encoding (spec
 * §14.1). `requested === "auto"` follows the detection order in spec §5.3:
 * UTF-8 BOM / strict UTF-8 first, then CP932 with the confidence checks from
 * §5.4. Manual "utf-8"/"shift_jis" skip detection and decode directly —
 * strict for UTF-8 (an invalid byte sequence throws), unvalidated for
 * Shift_JIS (the user's explicit choice is trusted, matching a manual
 * override's usual semantics elsewhere in this codebase).
 */
export function decodeTextFile(bytes: Uint8Array, requested: TextEncoding): DecodedText {
  if (hasUtf16Bom(bytes)) {
    throw new Utf16NotSupportedError("UTF-16 is not supported");
  }
  if (looksBinary(bytes)) {
    throw new BinaryTextFileError("binary input");
  }

  if (requested === "utf-8") {
    const text = tryDecodeUtf8Strict(bytes);
    if (text === null) {
      throw new EncodingDetectionFailedError("unable to decode as UTF-8");
    }
    return { text, encoding: "utf-8", confidence: "high" };
  }

  if (requested === "shift_jis") {
    return { text: decodeCp932(bytes), encoding: "shift_jis", confidence: "high" };
  }

  const utf8 = tryDecodeUtf8Strict(bytes);
  if (utf8 !== null) {
    return { text: utf8, encoding: "utf-8", confidence: "high" };
  }
  return decodeCp932WithValidation(bytes);
}
