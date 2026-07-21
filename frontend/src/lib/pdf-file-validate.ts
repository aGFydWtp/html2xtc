// SPDX-License-Identifier: AGPL-3.0-or-later
// PDFファイルのクライアント側初期検証（仕様書 §7.4）。
// 利便性向上用であり、サーバー側の再検証を代替しない。

export const MAX_UPLOAD_PDF_BYTES = 50331648; // 48 MiB（仕様書 §11.4 既定値）

const ALLOWED_MIME_TYPES = new Set(["", "application/pdf", "application/x-pdf"]);

export type PdfFileValidationErrorKind =
  | "not_pdf" // 拡張子・MIME不一致
  | "too_large"
  | "empty"
  | "magic_missing"; // 先頭付近に %PDF- が見つからない

export class PdfFileValidationError extends Error {
  readonly kind: PdfFileValidationErrorKind;
  constructor(kind: PdfFileValidationErrorKind, message: string) {
    super(message);
    this.name = "PdfFileValidationError";
    this.kind = kind;
  }
}

function hasPdfExtension(filename: string): boolean {
  return /\.pdf$/i.test(filename);
}

// 先頭 1024 バイト以内に "%PDF-" が存在するか（サーバー側検証 §11.3 と同じ探索幅）。
async function hasPdfMagic(file: File): Promise<boolean> {
  const head = await file.slice(0, 1024).arrayBuffer();
  const bytes = new Uint8Array(head);
  const needle = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  for (let i = 0; i <= bytes.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

// ファイルが 1 件・空でないファイル名・拡張子/MIME/サイズ/PDFマジックを満たすか検証する。
// 満たさなければ PdfFileValidationError を投げる。
export async function validatePdfFile(
  file: File,
  maxBytes: number = MAX_UPLOAD_PDF_BYTES,
): Promise<void> {
  if (!file.name.trim() || !hasPdfExtension(file.name)) {
    throw new PdfFileValidationError("not_pdf", "not a PDF file (extension)");
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new PdfFileValidationError("not_pdf", `unsupported MIME type: ${file.type}`);
  }
  if (file.size <= 0) {
    throw new PdfFileValidationError("empty", "file is empty");
  }
  if (file.size > maxBytes) {
    throw new PdfFileValidationError("too_large", `file exceeds ${maxBytes} bytes`);
  }
  if (!(await hasPdfMagic(file))) {
    throw new PdfFileValidationError("magic_missing", "missing %PDF- magic bytes");
  }
}
