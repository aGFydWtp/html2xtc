// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  computeCropRect,
  computeFitPlacement,
  computeInnerFrame,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  rotatedSize,
} from "../src/lib/pdf-preview";

describe("computeInnerFrame", () => {
  it("returns the full output area when marginPx is 0", () => {
    expect(computeInnerFrame(0)).toEqual({ x: 0, y: 0, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT });
  });

  it("shrinks symmetrically for a given margin", () => {
    const frame = computeInnerFrame(64);
    expect(frame).toEqual({ x: 64, y: 64, width: OUTPUT_WIDTH - 128, height: OUTPUT_HEIGHT - 128 });
  });

  it("keeps a positive size even at the maximum margin (64px, §6.3)", () => {
    const frame = computeInnerFrame(64);
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
  });
});

describe("computeCropRect", () => {
  it("returns the full rect when crop is all zero", () => {
    expect(computeCropRect(1000, 2000, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual({
      x: 0, y: 0, width: 1000, height: 2000,
    });
  });

  it("removes the given fraction from each side (§11.6 rounding)", () => {
    const rect = computeCropRect(1000, 2000, { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });
    expect(rect).toEqual({ x: 100, y: 200, width: 800, height: 1600 });
  });

  it("never returns a zero or negative size", () => {
    const rect = computeCropRect(10, 10, { top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 });
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
  });
});

describe("computeFitPlacement", () => {
  const inner = { x: 0, y: 0, width: 500, height: 500 };

  it("contain: scales down to the smaller ratio and centers", () => {
    // 1000x500 の横長画像を 500x500 の枠へ contain → 幅基準で 0.5 倍
    const p = computeFitPlacement(1000, 500, inner, "contain");
    expect(p.scale).toBeCloseTo(0.5);
    expect(p.drawWidth).toBeCloseTo(500);
    expect(p.drawHeight).toBeCloseTo(250);
    expect(p.dx).toBeCloseTo(0);
    expect(p.dy).toBeCloseTo(125);
  });

  it("cover: scales up to the larger ratio, overflowing one axis", () => {
    const p = computeFitPlacement(1000, 500, inner, "cover");
    expect(p.scale).toBeCloseTo(1);
    expect(p.drawWidth).toBeCloseTo(1000);
    expect(p.drawHeight).toBeCloseTo(500);
    expect(p.dx).toBeCloseTo(-250); // 中央基準ではみ出し
    expect(p.dy).toBeCloseTo(0);
  });
});

describe("rotatedSize", () => {
  it("keeps dimensions for 0 and 180 degrees", () => {
    expect(rotatedSize(300, 400, 0)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(300, 400, 180)).toEqual({ width: 300, height: 400 });
  });

  it("swaps dimensions for 90 and 270 degrees", () => {
    expect(rotatedSize(300, 400, 90)).toEqual({ width: 400, height: 300 });
    expect(rotatedSize(300, 400, 270)).toEqual({ width: 400, height: 300 });
  });
});
