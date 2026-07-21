// SPDX-License-Identifier: AGPL-3.0-or-later
// アップロード前ローカルプレビューの描画パイプライン（仕様書 §7.6〜7.8）。
//
// 処理順序（§6 と同じ）: ページ選択 → 回転 → クロップ → contain/cover 配置
// → 余白 → グレースケール化 → 528×792 → 白黒反転 → 二値化/ディザリング。
//
// 幾何計算（回転なしの純粋関数）はテスト可能。Canvas を実際に描画する関数は
// ブラウザ依存のため単体テスト対象外（手動確認 + ビルド確認でカバーする）。

import type { PDFPageProxy } from "pdfjs-dist";
import type { PdfCrop, PdfConvertOptions } from "./pdf-options";
import type { DitherRequest, DitherResponse } from "./pdf-dither.worker";

export const OUTPUT_WIDTH = 528;
export const OUTPUT_HEIGHT = 792;
export const PDF_PREVIEW_DPI = 200;
export const PREVIEW_SCALE = PDF_PREVIEW_DPI / 72;
export const REDRAW_DEBOUNCE_MS = 150;
export const PAGE_CACHE_LIMIT = 3;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// X3 出力領域内の「内側表示領域」（仕様書 §6.3）。marginPx=64 でも正のサイズを保証する。
export function computeInnerFrame(marginPx: number): Rect {
  const left = marginPx;
  const top = marginPx;
  const width = Math.max(1, OUTPUT_WIDTH - marginPx * 2);
  const height = Math.max(1, OUTPUT_HEIGHT - marginPx * 2);
  return { x: left, y: top, width, height };
}

// 回転後ページに対するクロップ率からピクセル矩形を求める（§11.6 と同じ丸め方）。
export function computeCropRect(width: number, height: number, crop: PdfCrop): Rect {
  const left = Math.round(width * crop.left);
  const top = Math.round(height * crop.top);
  const right = width - Math.round(width * crop.right);
  const bottom = height - Math.round(height * crop.bottom);
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  return { x: left, y: top, width: w, height: h };
}

export interface Placement {
  scale: number;
  drawWidth: number;
  drawHeight: number;
  /** 内側表示領域の左上を原点とした描画オフセット */
  dx: number;
  dy: number;
}

// contain: 全体が収まる最大サイズで中央配置。cover: 内側表示領域を埋めるまで
// 拡大し、はみ出しは呼び出し側で clip する（中央基準）。
export function computeFitPlacement(
  srcWidth: number,
  srcHeight: number,
  inner: Rect,
  fit: "contain" | "cover",
): Placement {
  const scale = fit === "contain"
    ? Math.min(inner.width / srcWidth, inner.height / srcHeight)
    : Math.max(inner.width / srcWidth, inner.height / srcHeight);
  const drawWidth = srcWidth * scale;
  const drawHeight = srcHeight * scale;
  return {
    scale,
    drawWidth,
    drawHeight,
    dx: (inner.width - drawWidth) / 2,
    dy: (inner.height - drawHeight) / 2,
  };
}

// 90/270度回転時に幅と高さが入れ替わることを踏まえた、回転後の寸法。
export function rotatedSize(width: number, height: number, rotation: 0 | 90 | 180 | 270): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

// --- Canvas 描画（ブラウザ専用） -------------------------------------------

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = canvas.getContext("2d");
  if (!c) throw new Error("2d context unavailable");
  return c;
}

// PDF.js で 1 ページを DPI 相当の解像度で描画する（§7.6）。
export async function renderPdfPageToCanvas(page: PDFPageProxy, dpi: number = PDF_PREVIEW_DPI): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = newCanvas(viewport.width, viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

// 回転 → クロップ（回転後ページに対する比率）。
export function applyRotationAndCrop(source: HTMLCanvasElement, rotation: 0 | 90 | 180 | 270, crop: PdfCrop): HTMLCanvasElement {
  const { width: rw, height: rh } = rotatedSize(source.width, source.height, rotation);
  const rotated = newCanvas(rw, rh);
  const rctx = ctx2d(rotated);
  rctx.save();
  rctx.translate(rw / 2, rh / 2);
  rctx.rotate((rotation * Math.PI) / 180);
  rctx.drawImage(source, -source.width / 2, -source.height / 2);
  rctx.restore();

  const cropRect = computeCropRect(rw, rh, crop);
  const cropped = newCanvas(cropRect.width, cropRect.height);
  const cctx = ctx2d(cropped);
  cctx.drawImage(
    rotated,
    cropRect.x, cropRect.y, cropRect.width, cropRect.height,
    0, 0, cropRect.width, cropRect.height,
  );
  return cropped;
}

// contain/cover 配置 + 余白を適用し、528×792 の白背景キャンバスへ配置する。
export function placeInFrame(source: HTMLCanvasElement, fit: "contain" | "cover", marginPx: number): HTMLCanvasElement {
  const out = newCanvas(OUTPUT_WIDTH, OUTPUT_HEIGHT);
  const octx = ctx2d(out);
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

  const inner = computeInnerFrame(marginPx);
  const placement = computeFitPlacement(source.width, source.height, inner, fit);

  octx.save();
  octx.beginPath();
  octx.rect(inner.x, inner.y, inner.width, inner.height);
  octx.clip(); // cover ではみ出した部分を切り落とす
  octx.drawImage(
    source,
    inner.x + placement.dx, inner.y + placement.dy,
    placement.drawWidth, placement.drawHeight,
  );
  octx.restore();
  return out;
}

export interface GrayscaleImage {
  gray: Uint8ClampedArray;
  width: number;
  height: number;
}

// グレースケール化（ITU-R BT.601 輝度係数）。
export function toGrayscale(canvas: HTMLCanvasElement): GrayscaleImage {
  const context = ctx2d(canvas);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { gray, width, height };
}

// 0/255 の 1-bit 相当バッファを表示用グレースケール Canvas に変換する。
export function bitsToCanvas(bits: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = newCanvas(width, height);
  const context = ctx2d(canvas);
  const imageData = context.createImageData(width, height);
  for (let p = 0, i = 0; p < bits.length; p++, i += 4) {
    const v = bits[p];
    imageData.data[i] = v;
    imageData.data[i + 1] = v;
    imageData.data[i + 2] = v;
    imageData.data[i + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

// 回転・クロップ・contain/cover・余白・グレースケール化までを 1 回で行う
// （しきい値・反転・ディザリングより手前の共有ステップ、§7.8 のキャッシュ階層参照）。
export function buildGrayscaleFrame(pageCanvas: HTMLCanvasElement, options: PdfConvertOptions): GrayscaleImage {
  const rotatedCropped = applyRotationAndCrop(pageCanvas, options.rotation, options.crop);
  const framed = placeInFrame(rotatedCropped, options.fit, options.marginPx);
  return toGrayscale(framed);
}

// --- ディザリング Worker クライアント ---------------------------------------
// 連投されたリクエストのうち、最新の requestId 以外の応答は無視することで、
// 150ms デバウンス中に発生し得る古い計算結果の描画を防ぐ。

export class DitherWorkerClient {
  private worker: Worker;
  private nextId = 0;
  private latestId = -1;
  private pending = new Map<number, (bits: Uint8ClampedArray) => void>();

  constructor() {
    this.worker = new Worker(new URL("./pdf-dither.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<DitherResponse>) => {
      const { requestId, bits } = event.data;
      const resolve = this.pending.get(requestId);
      this.pending.delete(requestId);
      if (requestId === this.latestId && resolve) resolve(new Uint8ClampedArray(bits));
    };
  }

  async run(image: GrayscaleImage, options: PdfConvertOptions): Promise<Uint8ClampedArray | null> {
    const requestId = this.nextId++;
    this.latestId = requestId;
    const grayCopy = image.gray.slice(); // transfer 用に複製（呼び出し側の gray を消費しない）
    const request: DitherRequest = {
      requestId,
      gray: grayCopy.buffer,
      width: image.width,
      height: image.height,
      threshold: options.threshold,
      dither: options.dither,
      ditherStrength: options.ditherStrength,
      invert: options.invert,
    };
    return new Promise((resolve) => {
      this.pending.set(requestId, (bits) => resolve(requestId === this.latestId ? bits : null));
      this.worker.postMessage(request, [grayCopy.buffer]);
    });
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

// --- ページごとのキャッシュ（最大 PAGE_CACHE_LIMIT ページ） ------------------
// キー: ページ番号。値: PDF.js 描画結果（回転・クロップの起点になる生 Canvas）。
export class LimitedPageCache<T> {
  private map = new Map<number, T>();
  constructor(private limit: number = PAGE_CACHE_LIMIT) {}

  get(page: number): T | undefined {
    return this.map.get(page);
  }

  set(page: number, value: T): void {
    this.map.delete(page); // LRU: 既存キーは末尾へ移動
    this.map.set(page, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
