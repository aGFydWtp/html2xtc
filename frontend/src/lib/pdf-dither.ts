// SPDX-License-Identifier: AGPL-3.0-or-later
// 1-bit 化アルゴリズム（純粋関数、DOM 非依存）。
// pdf-dither.worker.ts から呼ばれるほか、テストからも直接呼べる。

// しきい値だけによる単純二値化（ディザリングなし）。
export function thresholdBinarize(
  gray: Uint8ClampedArray,
  threshold: number,
  invert: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.length);
  const onValue = invert ? 0 : 255;
  const offValue = invert ? 255 : 0;
  for (let i = 0; i < gray.length; i++) {
    out[i] = gray[i] >= threshold ? onValue : offValue;
  }
  return out;
}

// Floyd–Steinberg ディザリング。ditherStrength（0.0〜1.0）は、二値化で生じる
// 誤差のうち何割を周囲画素へ伝播させるかを表す。0 なら実質しきい値二値化と同じ、
// 1 なら標準的な Floyd–Steinberg になる。
export function floydSteinbergDither(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  ditherStrength: number,
  invert: boolean,
): Uint8ClampedArray {
  const buf = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) buf[i] = gray[i];

  const out = new Uint8ClampedArray(gray.length);
  const strength = Math.max(0, Math.min(1, ditherStrength));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i];
      const isOn = old >= threshold;
      const newValue = isOn ? 255 : 0;
      out[i] = isOn ? (invert ? 0 : 255) : (invert ? 255 : 0);

      const error = (old - newValue) * strength;
      if (error === 0) continue;

      if (x + 1 < width) buf[i + 1] += (error * 7) / 16;
      if (y + 1 < height) {
        if (x - 1 >= 0) buf[i + width - 1] += (error * 3) / 16;
        buf[i + width] += (error * 5) / 16;
        if (x + 1 < width) buf[i + width + 1] += (error * 1) / 16;
      }
    }
  }

  return out;
}
