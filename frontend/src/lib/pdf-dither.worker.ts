// SPDX-License-Identifier: AGPL-3.0-or-later
// プレビューの二値化・ディザリングを担う Web Worker（仕様書 §7.8）。
// メインスレッドをブロックしないよう、しきい値・反転・ディザリング変更時の
// 再計算はここで行う。グレースケール画素バッファは Transferable で受け渡す。

import { floydSteinbergDither, thresholdBinarize } from "./pdf-dither";

export interface DitherRequest {
  requestId: number;
  gray: ArrayBuffer; // Uint8ClampedArray の中身（グレースケール、1 画素 1 バイト）
  width: number;
  height: number;
  threshold: number;
  dither: boolean;
  ditherStrength: number;
  invert: boolean;
}

export interface DitherResponse {
  requestId: number;
  bits: ArrayBuffer; // Uint8ClampedArray の中身（0 または 255、1 画素 1 バイト）
  width: number;
  height: number;
}

self.onmessage = (event: MessageEvent<DitherRequest>) => {
  const { requestId, gray, width, height, threshold, dither, ditherStrength, invert } = event.data;
  const grayArr = new Uint8ClampedArray(gray);
  const out = dither
    ? floydSteinbergDither(grayArr, width, height, threshold, ditherStrength, invert)
    : thresholdBinarize(grayArr, threshold, invert);
  // Uint8ClampedArray は常に (Shared ではない) 通常の ArrayBuffer で裏付けられる
  // ため、Transferable としての型を明示的に絞る。
  const buffer = out.buffer as ArrayBuffer;
  const response: DitherResponse = { requestId, bits: buffer, width, height };
  (self as unknown as Worker).postMessage(response, [buffer]);
};
