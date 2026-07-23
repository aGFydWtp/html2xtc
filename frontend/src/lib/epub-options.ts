// SPDX-License-Identifier: AGPL-3.0-or-later
// EPUB 変換オプション（実装仕様書 §4.1.3-4.1.5）と、アップロード API ヘッダー用の base64url エンコード。

import { encodeBase64UrlUtf8 } from "./pdf-options";
import { isValidFontFamily } from "./text-options";

export type EpubLayout = "auto" | "horizontal" | "vertical";

export interface EpubConvertOptions {
  /** "auto" は EPUB 自体の指定（縦書き/横書き）に従う。 */
  layout: EpubLayout;
  /** Google Fontsのfamily名 */
  font: string;
  /** CSS px */
  fontSizePx: number;
  /** X3 出力領域の均一余白。単位は px */
  marginPx: number;
  /** 章（spine item）ごとに改ページするか */
  chapterPageBreak: boolean;
  /** 表紙を含めるか */
  includeCover: boolean;
  /** 目次を含めるか */
  includeTableOfContents: boolean;
}

// 実装仕様書 §4.1.4
export const DEFAULT_EPUB_OPTIONS: EpubConvertOptions = {
  layout: "auto",
  font: "BIZ UDMincho",
  fontSizePx: 24,
  marginPx: 40,
  chapterPageBreak: true,
  includeCover: true,
  includeTableOfContents: false,
};

// 実装仕様書 §4.1.5 の範囲
export const FONT_SIZE_PX_MIN = 12;
export const FONT_SIZE_PX_MAX = 40;
export const MARGIN_PX_MIN = 0;
export const MARGIN_PX_MAX = 120;

export interface EpubOptionsValidationError {
  field: string;
  message: string;
}

// 実装仕様書 §4.1.5 の制約どおりに検証する。不正な X-Epub-Options は 400 になる
// （URL変換の layout/font のようなフェイルソフトではなく、アップロード系オプション
// として厳格に検証する — §4.1.5）。有効なら []、無効ならエラー一覧を返す。
export function validateEpubOptions(options: EpubConvertOptions): EpubOptionsValidationError[] {
  const errors: EpubOptionsValidationError[] = [];

  if (options.layout !== "auto" && options.layout !== "horizontal" && options.layout !== "vertical") {
    errors.push({ field: "layout", message: 'layout must be "auto", "horizontal" or "vertical"' });
  }
  if (!isValidFontFamily(options.font)) {
    errors.push({ field: "font", message: "font must be a valid font family name (64 chars max)" });
  }
  if (
    !Number.isInteger(options.fontSizePx) ||
    options.fontSizePx < FONT_SIZE_PX_MIN ||
    options.fontSizePx > FONT_SIZE_PX_MAX
  ) {
    errors.push({
      field: "fontSizePx",
      message: `fontSizePx must be an integer between ${FONT_SIZE_PX_MIN} and ${FONT_SIZE_PX_MAX}`,
    });
  }
  if (!Number.isInteger(options.marginPx) || options.marginPx < MARGIN_PX_MIN || options.marginPx > MARGIN_PX_MAX) {
    errors.push({
      field: "marginPx",
      message: `marginPx must be an integer between ${MARGIN_PX_MIN} and ${MARGIN_PX_MAX}`,
    });
  }
  if (typeof options.chapterPageBreak !== "boolean") {
    errors.push({ field: "chapterPageBreak", message: "chapterPageBreak must be boolean" });
  }
  if (typeof options.includeCover !== "boolean") {
    errors.push({ field: "includeCover", message: "includeCover must be boolean" });
  }
  if (typeof options.includeTableOfContents !== "boolean") {
    errors.push({ field: "includeTableOfContents", message: "includeTableOfContents must be boolean" });
  }

  return errors;
}

export function isValidEpubOptions(options: EpubConvertOptions): boolean {
  return validateEpubOptions(options).length === 0;
}

// --- API送信用ヘッダーエンコード（仕様書 §16.5 X-Epub-Options） -------------------
// base64url(UTF-8) エンコード自体は pdf-options.ts の encodeBase64UrlUtf8 を再利用する
// （PDF/TXT/EPUBで共通のエンコード規則のため）。
export function encodeEpubOptionsHeader(options: EpubConvertOptions): string {
  return encodeBase64UrlUtf8(JSON.stringify(options));
}
