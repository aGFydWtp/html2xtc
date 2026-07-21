// SPDX-License-Identifier: AGPL-3.0-or-later
// 文字コードの自動判定・デコード（実装仕様書 §5）。
//
// workerd/ブラウザ双方の TextDecoder の非 UTF-8 対応は成熟度に差があるため
// （調査レポート §0-2, §1.5）、Shift_JIS/CP932 は純 JS 実装の encoding-japanese を
// 使う。UTF-8 のみブラウザ標準の TextDecoder(fatal:true) を使う。

import * as EncodingJapanese from "encoding-japanese";
import type { TextEncoding } from "./text-options";

export type DetectedTextEncoding = "utf-8" | "shift_jis";

export interface EncodingDetectionResult {
  encoding: DetectedTextEncoding;
  confidence: "high" | "medium" | "low";
  replacementRatio: number;
}

export type TextDecodeErrorKind =
  | "encoding_unknown"
  | "utf16"
  | "binary"
  | "empty"; // UTF-8としてデコードは成功したが有効な文字が無い（空白のみ）

export class TextDecodeError extends Error {
  readonly kind: TextDecodeErrorKind;
  constructor(kind: TextDecodeErrorKind, message: string) {
    super(message);
    this.name = "TextDecodeError";
    this.kind = kind;
  }
}

const REPLACEMENT_CHAR = "�";
// §5.4: デコード後の置換文字が非空白文字の1%以上で判定失敗。
const REPLACEMENT_RATIO_MAX = 0.01;

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasNulByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeShiftJis(bytes: Uint8Array): string {
  // "SJIS" 判定は CP932 (Windows-31J) の拡張文字（丸数字・ローマ数字等）も含めて
  // デコードする（encoding-japanese の SJIS デコーダは CP932 拡張領域を含む）。
  return EncodingJapanese.convert(bytes, { to: "UNICODE", from: "SJIS", type: "string" });
}

function replacementRatio(text: string): number {
  let replaced = 0;
  let nonBlank = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    nonBlank++;
    if (ch === REPLACEMENT_CHAR) replaced++;
  }
  if (nonBlank === 0) return 1; // 非空白文字が無い = 有効な文字が無い扱い
  return replaced / nonBlank;
}

function hasValidContent(text: string): boolean {
  for (const ch of text) {
    if (!/\s/.test(ch) && ch !== REPLACEMENT_CHAR) return true;
  }
  return false;
}

interface DecodedText {
  text: string;
  result: EncodingDetectionResult;
}

// §5.3 の自動判定手順（1: UTF-8 BOM検出 → 2: UTF-8 fatal decode成功 →
// 3: Shift_JIS/CP932としてデコード → 4: 置換文字率検証 → 5: 判定失敗）。
//
// Shift_JIS受理はサーバー（src/text-decode.ts の decodeCp932WithValidation）
// と同じ二段ゲート: まず EncodingJapanese.detect(bytes, "SJIS") でバイト列が
// 構造的にShift_JIS/CP932らしいか判定し（ゴミバイト列を弾く一次ゲート）、
// 通った場合のみ実際にデコードして置換文字率+有効文字チェック（二次ゲート）
// を行う。detect() を経ずに変換結果だけを見ると、encoding-japanese の
// convert() は未定義バイトを "?" などへ寛容に変換してしまい、置換文字率が
// ほぼ0のまま「ゴミバイト列」を通してしまう（サーバー側と同じ既知の弱点）。
function autoDetect(bytes: Uint8Array): DecodedText {
  const utf8 = decodeUtf8Strict(bytes);
  if (utf8 !== null) {
    const text = stripUtf8Bom(utf8);
    if (hasValidContent(text)) {
      return {
        text,
        result: { encoding: "utf-8", confidence: hasUtf8Bom(bytes) ? "high" : "medium", replacementRatio: 0 },
      };
    }
    // UTF-8としてのデコード自体は成功しているが、中身が空白のみ:
    // 文字コード不明ではなく空ファイル相当（text_err_empty につながる種別）。
    throw new TextDecodeError("empty", "decoded text has no valid characters");
  }
  if (EncodingJapanese.detect(bytes, "SJIS")) {
    const sjisText = decodeShiftJis(bytes);
    const ratio = replacementRatio(sjisText);
    if (ratio < REPLACEMENT_RATIO_MAX && hasValidContent(sjisText)) {
      return {
        text: sjisText,
        result: { encoding: "shift_jis", confidence: ratio === 0 ? "high" : "medium", replacementRatio: ratio },
      };
    }
  }
  throw new TextDecodeError("encoding_unknown", "could not detect text encoding");
}

/**
 * バイト列をデコードする。requested === "auto" のときは §5.3 の自動判定手順を、
 * それ以外は指定エンコーディングで直接デコードして §5.4 の基準で検証する。
 */
export function decodeTextBytes(bytes: Uint8Array, requested: TextEncoding): DecodedText {
  if (hasUtf16Bom(bytes)) throw new TextDecodeError("utf16", "UTF-16 is not supported");
  if (hasNulByte(bytes)) throw new TextDecodeError("binary", "binary content detected (NUL byte)");

  if (requested === "auto") return autoDetect(bytes);

  if (requested === "utf-8") {
    const decoded = decodeUtf8Strict(bytes);
    if (decoded === null) throw new TextDecodeError("encoding_unknown", "not valid UTF-8");
    const text = stripUtf8Bom(decoded);
    if (!hasValidContent(text)) throw new TextDecodeError("encoding_unknown", "decoded text has no valid characters");
    return { text, result: { encoding: "utf-8", confidence: "high", replacementRatio: 0 } };
  }

  // requested === "shift_jis"
  const text = decodeShiftJis(bytes);
  const ratio = replacementRatio(text);
  if (ratio >= REPLACEMENT_RATIO_MAX || !hasValidContent(text)) {
    throw new TextDecodeError("encoding_unknown", "could not decode as Shift_JIS");
  }
  return { text, result: { encoding: "shift_jis", confidence: ratio === 0 ? "high" : "medium", replacementRatio: ratio } };
}
