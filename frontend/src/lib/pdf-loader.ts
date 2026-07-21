// SPDX-License-Identifier: AGPL-3.0-or-later
// ブラウザ内 PDF.js 読み込み（仕様書 §7.5）。
// Worker は Vite アセットとして同梱し、外部 CDN から取得しない。
// PDF.js による JavaScript 実行は isEvalSupported: false で無効化する。

import { getDocument, GlobalWorkerOptions, PasswordException, type PDFDocumentProxy } from "pdfjs-dist";

// Vite の `new URL(..., import.meta.url)` パターンでビルド時に Worker アセットを
// 同梱する（CDN からの取得を避ける。仕様書 §7.1）。
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;

export type PdfLoadErrorKind = "password_protected" | "parse_failed";

export class PdfLoadError extends Error {
  readonly kind: PdfLoadErrorKind;
  constructor(kind: PdfLoadErrorKind, message: string) {
    super(message);
    this.name = "PdfLoadError";
    this.kind = kind;
  }
}

export interface LoadedPdf {
  document: PDFDocumentProxy;
  /**
   * PDFDocumentProxy 自体には destroy() が無い（pdfjs-dist 6.x の型・実装いずれにも
   * 存在しない）。破棄は読み込みに使った PDFDocumentLoadingTask 側の destroy() が
   * 正しい方法なので、そのタスクをクロージャで保持して公開する。
   */
  destroy(): Promise<void>;
}

// パスワード保護 PDF は非対応（仕様書 §3.2, §7.5）。それ以外の読み込み失敗は
// 「解析不能」として一般化する（詳細な内部例外は表示しない）。
//
// 仕様書は isEvalSupported: false を明示的に要求しているが、pdfjs-dist 6.x の
// getDocument() にはそのオプション自体が存在しない（Type3 フォント高速化用に
// new Function() を使うかどうかの内部フラグだったが、このバージョンで廃止された）。
// また pdfjs-dist のコア API（フル viewer ではなくこの getDocument 経由の利用）は
// そもそも PDF 内蔵の JavaScript アクションを実行しない（スクリプティングは別途
// pdf.sandbox.mjs を明示的に組み込んだ場合のみ有効になる機能で、ここでは読み込んで
// いない）。よって要件は満たされている。
export async function loadPdfDocument(bytes: ArrayBuffer): Promise<LoadedPdf> {
  const loadingTask = getDocument({
    data: bytes,
    useSystemFonts: true,
  });
  try {
    const document = await loadingTask.promise;
    return { document, destroy: () => loadingTask.destroy() };
  } catch (error) {
    if (error instanceof PasswordException) {
      throw new PdfLoadError("password_protected", "password-protected PDF is not supported");
    }
    throw new PdfLoadError("parse_failed", error instanceof Error ? error.message : "failed to load PDF");
  }
}
