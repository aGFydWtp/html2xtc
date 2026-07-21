// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF 変換オプション（仕様書 §5）と、アップロード API ヘッダー用の base64url エンコード。

import { isValidPagesSyntax } from "./pdf-page-range";

export interface PdfCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PdfConvertOptions {
  /** 対象ページ。例: "1-10", "1,3,5-8", "5-", "-3" */
  pages: string;
  /** 全ページ共通の回転角 */
  rotation: 0 | 90 | 180 | 270;
  /** 回転後ページに対するクロップ率。0.0〜0.4。0.1 は辺から 10% を除去する。 */
  crop: PdfCrop;
  /** X3 表示領域への収め方 */
  fit: "contain" | "cover";
  /** X3 出力画像内の均一余白。単位は X3 ピクセル */
  marginPx: number;
  /** 1-bit 化のしきい値 */
  threshold: number;
  /** Floyd–Steinberg ディザリング */
  dither: boolean;
  /** ディザリング強度 */
  ditherStrength: number;
  /** 白黒反転 */
  invert: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfConvertOptions = {
  pages: "1-",
  rotation: 0,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  fit: "contain",
  marginPx: 0,
  threshold: 128,
  dither: true,
  ditherStrength: 0.8,
  invert: false,
};

export const ROTATIONS = [0, 90, 180, 270] as const;
export const CROP_MAX = 0.4;
export const CROP_AXIS_SUM_MAX = 0.8;
export const MARGIN_PX_MAX = 64;
export const THRESHOLD_MAX = 255;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 1 フィールドぶんのバリデーションエラー。フォーム側でフィールドごとに表示する。 */
export interface PdfOptionsValidationError {
  field: string;
  message: string;
}

// 仕様書 §5.3 の制約どおりに検証する。不正値は暗黙補正しない。
// 有効なら null、無効ならエラー一覧（1 件以上）を返す。
export function validatePdfOptions(options: PdfConvertOptions): PdfOptionsValidationError[] {
  const errors: PdfOptionsValidationError[] = [];

  if (!isValidPagesSyntax(options.pages)) {
    errors.push({ field: "pages", message: "invalid pages syntax" });
  }

  if (!(ROTATIONS as readonly number[]).includes(options.rotation)) {
    errors.push({ field: "rotation", message: "rotation must be 0, 90, 180 or 270" });
  }

  const { top, right, bottom, left } = options.crop;
  for (const [name, v] of [["top", top], ["right", right], ["bottom", bottom], ["left", left]] as const) {
    if (!isFiniteNumber(v) || v < 0 || v > CROP_MAX) {
      errors.push({ field: `crop.${name}`, message: `crop.${name} must be between 0.0 and ${CROP_MAX}` });
    }
  }
  if (isFiniteNumber(left) && isFiniteNumber(right) && left + right >= CROP_AXIS_SUM_MAX) {
    errors.push({ field: "crop.left+right", message: `crop left+right must be < ${CROP_AXIS_SUM_MAX}` });
  }
  if (isFiniteNumber(top) && isFiniteNumber(bottom) && top + bottom >= CROP_AXIS_SUM_MAX) {
    errors.push({ field: "crop.top+bottom", message: `crop top+bottom must be < ${CROP_AXIS_SUM_MAX}` });
  }

  if (options.fit !== "contain" && options.fit !== "cover") {
    errors.push({ field: "fit", message: 'fit must be "contain" or "cover"' });
  }

  if (!Number.isInteger(options.marginPx) || options.marginPx < 0 || options.marginPx > MARGIN_PX_MAX) {
    errors.push({ field: "marginPx", message: `marginPx must be an integer between 0 and ${MARGIN_PX_MAX}` });
  }

  if (!Number.isInteger(options.threshold) || options.threshold < 0 || options.threshold > THRESHOLD_MAX) {
    errors.push({ field: "threshold", message: `threshold must be an integer between 0 and ${THRESHOLD_MAX}` });
  }

  if (!isFiniteNumber(options.ditherStrength) || options.ditherStrength < 0 || options.ditherStrength > 1) {
    errors.push({ field: "ditherStrength", message: "ditherStrength must be between 0.0 and 1.0" });
  }

  if (typeof options.dither !== "boolean") errors.push({ field: "dither", message: "dither must be boolean" });
  if (typeof options.invert !== "boolean") errors.push({ field: "invert", message: "invert must be boolean" });

  return errors;
}

export function isValidPdfOptions(options: PdfConvertOptions): boolean {
  return validatePdfOptions(options).length === 0;
}

// --- base64url(UTF-8) エンコード（仕様書 §8.1 X-File-Name / X-Pdf-Options） -------

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeBase64UrlUtf8(text: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(text));
}

export function encodePdfOptionsHeader(options: PdfConvertOptions): string {
  return encodeBase64UrlUtf8(JSON.stringify(options));
}

export function encodeFileNameHeader(filename: string): string {
  return encodeBase64UrlUtf8(filename);
}
