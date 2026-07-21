// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { floydSteinbergDither, thresholdBinarize } from "../src/lib/pdf-dither";

describe("thresholdBinarize", () => {
  it("maps values below threshold to black (0) and at/above to white (255)", () => {
    const gray = new Uint8ClampedArray([0, 100, 127, 128, 200, 255]);
    expect(Array.from(thresholdBinarize(gray, 128, false))).toEqual([0, 0, 0, 255, 255, 255]);
  });

  it("inverts the result when invert is true", () => {
    const gray = new Uint8ClampedArray([0, 255]);
    expect(Array.from(thresholdBinarize(gray, 128, true))).toEqual([255, 0]);
  });
});

describe("floydSteinbergDither", () => {
  it("returns only 0/255 values", () => {
    const width = 4;
    const height = 4;
    const gray = new Uint8ClampedArray(width * height).map((_, i) => (i * 37) % 256);
    const out = floydSteinbergDither(gray, width, height, 128, 0.8, false);
    for (const v of out) expect(v === 0 || v === 255).toBe(true);
  });

  it("behaves like plain thresholding when ditherStrength is 0", () => {
    const width = 3;
    const height = 3;
    const gray = new Uint8ClampedArray([10, 200, 50, 130, 60, 250, 0, 255, 128]);
    const dithered = floydSteinbergDither(gray, width, height, 128, 0, false);
    const plain = thresholdBinarize(gray, 128, false);
    expect(Array.from(dithered)).toEqual(Array.from(plain));
  });

  it("respects invert", () => {
    const width = 2;
    const height = 1;
    const gray = new Uint8ClampedArray([0, 255]);
    const out = floydSteinbergDither(gray, width, height, 128, 0, true);
    expect(Array.from(out)).toEqual([255, 0]);
  });

  it("a uniform white image stays fully white", () => {
    const width = 5;
    const height = 5;
    const gray = new Uint8ClampedArray(width * height).fill(255);
    const out = floydSteinbergDither(gray, width, height, 128, 1, false);
    expect(Array.from(out).every((v) => v === 255)).toBe(true);
  });

  it("a uniform black image stays fully black", () => {
    const width = 5;
    const height = 5;
    const gray = new Uint8ClampedArray(width * height).fill(0);
    const out = floydSteinbergDither(gray, width, height, 128, 1, false);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });
});
