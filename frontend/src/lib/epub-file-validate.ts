// SPDX-License-Identifier: AGPL-3.0-or-later
// EPUBファイルのクライアント側初期検証（実装仕様書 §16.3）。
// 利便性向上用であり、サーバー側の再検証を代替しない（仕様書 §16.3 に明記）。

export const MAX_UPLOAD_EPUB_BYTES = 50331648; // 48 MiB（仕様書 §5 既定値。バックエンド MAX_UPLOAD_EPUB_BYTES と一致させること）

const ALLOWED_MIME_TYPES = new Set(["", "application/epub+zip", "application/octet-stream"]);

export type EpubFileValidationErrorKind =
  | "not_epub" // 拡張子・MIME不一致
  | "too_large"
  | "empty"
  | "magic_missing"; // 先頭に ZIP local file header magic (PK\x03\x04) が見つからない

export class EpubFileValidationError extends Error {
  readonly kind: EpubFileValidationErrorKind;
  constructor(kind: EpubFileValidationErrorKind, message: string) {
    super(message);
    this.name = "EpubFileValidationError";
    this.kind = kind;
  }
}

function hasEpubExtension(filename: string): boolean {
  return /\.epub$/i.test(filename);
}

// EPUB は ZIP アーカイブであり、ZIP local file header magic "PK\x03\x04" は
// 常にオフセット0に固定される（PDFの %PDF- 探索と異なりスキャン不要）。
async function hasZipMagic(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

// ファイルが空でないファイル名・拡張子/MIME/サイズ/ZIPマジックを満たすか検証する。
// 満たさなければ EpubFileValidationError を投げる。
export async function validateEpubFile(
  file: File,
  maxBytes: number = MAX_UPLOAD_EPUB_BYTES,
): Promise<void> {
  if (!file.name.trim() || !hasEpubExtension(file.name)) {
    throw new EpubFileValidationError("not_epub", "not an EPUB file (extension)");
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new EpubFileValidationError("not_epub", `unsupported MIME type: ${file.type}`);
  }
  if (file.size <= 0) {
    throw new EpubFileValidationError("empty", "file is empty");
  }
  if (file.size > maxBytes) {
    throw new EpubFileValidationError("too_large", `file exceeds ${maxBytes} bytes`);
  }
  if (!(await hasZipMagic(file))) {
    throw new EpubFileValidationError("magic_missing", "missing ZIP local file header magic bytes");
  }
}
