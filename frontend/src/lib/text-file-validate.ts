// SPDX-License-Identifier: AGPL-3.0-or-later
// TXTファイルのクライアント側初期検証（実装仕様書 §10.4）。
// 利便性向上用であり、サーバー側の再検証を代替しない。

export const MAX_UPLOAD_TEXT_BYTES = 5 * 1024 * 1024; // 5 MiB（仕様書 §7）

const ALLOWED_MIME_TYPES = new Set(["", "text/plain"]);

export type TextFileValidationErrorKind =
  | "not_text" // 拡張子・MIME不一致
  | "too_large"
  | "empty"
  | "utf16" // UTF-16 BOM検出
  | "binary"; // NULバイト・既知のバイナリマジック・制御バイト比率超過

export class TextFileValidationError extends Error {
  readonly kind: TextFileValidationErrorKind;
  constructor(kind: TextFileValidationErrorKind, message: string) {
    super(message);
    this.name = "TextFileValidationError";
    this.kind = kind;
  }
}

function hasTextExtension(filename: string): boolean {
  return /\.txt$/i.test(filename);
}

// サーバー側 (src/text-decode.ts looksBinary) と同じ判定基準に揃える(仕様書
// §14.4): 先頭64KiBだけ読めば、マジックヘッダーや制御バイト密度を検出するのに
// 十分(ファイル全体を読まずに済む)。
const SNIFF_BYTES = 64 * 1024;

// サーバー(src/text-decode.ts BINARY_MAGICS)と同一の既知バイナリマジック。
const BINARY_MAGICS: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP / docx / xlsx / epub / ...
  [0x50, 0x4b, 0x05, 0x06], // ZIP (empty archive)
  [0x50, 0x4b, 0x07, 0x08], // ZIP (spanned archive)
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF87a / GIF89a
];

// 制御バイト比率がこの値を超えるとバイナリ扱い(仕様書 §14.4、サーバーと同一)。
const MAX_CONTROL_BYTE_RATIO = 0.05;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

export function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

/**
 * バイナリファイル判定(仕様書 §14.4)。サーバー(src/text-decode.ts の
 * looksBinary)と同じ基準を移植したもの: 検査窓内のNULバイト、既知バイナリ
 * マジックの先頭一致、またはASCII制御バイト比率が5%を超えることのいずれか。
 * 制御バイトの判定はASCII C0範囲(0x00-0x1F、LF/TAB/CRは除く)とDEL(0x7F)の
 * みを対象にする — Shift_JIS/CP932のトレイルバイトは0x40-0x7Eに落ちて印字
 * 可能ASCIIと重なり、リードバイトは0x81以上なので、この範囲限定により
 * 日本語マルチバイト文字列を制御バイトとして誤検出しない。
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, SNIFF_BYTES);

  for (const magic of BINARY_MAGICS) {
    if (startsWith(window, magic)) return true;
  }

  let controlCount = 0;
  for (const byte of window) {
    if (byte === 0x00) return true;
    // LF/TAB/CR は正当な改行・空白バイトであり制御ノイズではない。
    const isC0Control = byte < 0x20 && byte !== 0x0a && byte !== 0x09 && byte !== 0x0d;
    const isDel = byte === 0x7f;
    if (isC0Control || isDel) controlCount++;
  }
  if (window.length === 0) return false;
  return controlCount / window.length > MAX_CONTROL_BYTE_RATIO;
}

// ファイルが空でないファイル名・拡張子/MIME/サイズ/先頭バイトの内容チェックを
// 満たすか検証する。満たさなければ TextFileValidationError を投げる。
export async function validateTextFile(
  file: File,
  maxBytes: number = MAX_UPLOAD_TEXT_BYTES,
): Promise<void> {
  if (!file.name.trim() || !hasTextExtension(file.name)) {
    throw new TextFileValidationError("not_text", "not a text file (extension)");
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new TextFileValidationError("not_text", `unsupported MIME type: ${file.type}`);
  }
  if (file.size <= 0) {
    throw new TextFileValidationError("empty", "file is empty");
  }
  if (file.size > maxBytes) {
    throw new TextFileValidationError("too_large", `file exceeds ${maxBytes} bytes`);
  }
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  if (hasUtf16Bom(head)) {
    throw new TextFileValidationError("utf16", "UTF-16 BOM detected");
  }
  if (looksBinary(head)) {
    throw new TextFileValidationError("binary", "binary content detected");
  }
}
