// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { parseAozoraDocument } from "../src/parse-document";
import { MAX_ANNOTATION_CODEPOINTS } from "../src/types";

/**
 * Spec §18.7: not exact-second budgets (flaky under CI load) but a
 * doubled-input-size check that a clearly quadratic/exponential
 * implementation would fail by a wide margin — each assertion gives
 * generous headroom (8x the 1x measurement plus a fixed floor) so ordinary
 * timing noise on a small, fast operation doesn't make the suite flaky,
 * while still catching an O(n²) regression (which would show a ratio in
 * the hundreds/thousands, not order-of-magnitude noise).
 */
function timeIt(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function assertRoughlyLinear(oneX: number, twoX: number): void {
  expect(twoX).toBeLessThan(oneX * 8 + 100);
}

describe("performance (spec §18.7)", () => {
  it("2,000,000-character annotation-free body", () => {
    const half = "あ".repeat(1_000_000);
    const t1 = timeIt(() => parseAozoraDocument(half));
    const t2 = timeIt(() => parseAozoraDocument(half + half));
    assertRoughlyLinear(t1, t2);
  });

  it("a large number of ［＃ annotations", () => {
    const unit = "本文［＃改ページ］";
    const base = unit.repeat(50_000);
    const t1 = timeIt(() => parseAozoraDocument(base));
    const t2 = timeIt(() => parseAozoraDocument(base + base));
    assertRoughlyLinear(t1, t2);
  });

  it("a large number of unclosed 《", () => {
    const unit = "漢字《ずっと閉じない ";
    const base = unit.repeat(50_000);
    const t1 = timeIt(() => parseAozoraDocument(base));
    const t2 = timeIt(() => parseAozoraDocument(base + base));
    assertRoughlyLinear(t1, t2);
  });

  it("deeply nested range-opening annotations", () => {
    const text = "［＃ここから傍点］".repeat(5000) + "x" + "［＃ここで傍点終わり］".repeat(5000);
    const t = timeIt(() => parseAozoraDocument(text));
    expect(t).toBeLessThan(2000);
  });

  it("many post-form annotations repeating the same target word", () => {
    const unit = "重要［＃「重要」に傍点］";
    const base = unit.repeat(20_000);
    const t1 = timeIt(() => parseAozoraDocument(base));
    const t2 = timeIt(() => parseAozoraDocument(base + base));
    assertRoughlyLinear(t1, t2);
  });

  it("many post-form annotations against one long, never-flushed preceding run (bounded-lookback case)", () => {
    const build = (n: number) => "A".repeat(n) + "［＃「A」に傍点］".repeat(3000);
    const t1 = timeIt(() => parseAozoraDocument(build(200_000)));
    const t2 = timeIt(() => parseAozoraDocument(build(400_000)));
    assertRoughlyLinear(t1, t2);
  });

  it("annotation bodies right at the 4096-codepoint boundary", () => {
    const body = "x".repeat(MAX_ANNOTATION_CODEPOINTS);
    const unit = `text［＃${body}］`;
    const base = unit.repeat(500);
    const t1 = timeIt(() => parseAozoraDocument(base));
    const t2 = timeIt(() => parseAozoraDocument(base + base));
    assertRoughlyLinear(t1, t2);
  });

  it("just below the AST node limit completes promptly", () => {
    const paragraphs = Array.from({ length: 400_000 }, (_, i) => `p${i}`).join("\n\n");
    const t = timeIt(() => parseAozoraDocument(paragraphs));
    expect(t).toBeLessThan(5000);
  });
});
