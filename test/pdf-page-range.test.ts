// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { resolvePageRange, validatePageRangeSyntax } from "../src/pdf-page-range";

describe("validatePageRangeSyntax", () => {
  it("accepts every form from spec §5.4", () => {
    for (const spec of ["1", "1-10", "1,3,5", "1-4,7,10-12", "5-", "-3", "1-"]) {
      expect(validatePageRangeSyntax(spec)).toBeNull();
    }
  });

  it("rejects every invalid form from spec §5.4", () => {
    for (const spec of ["0", "-0", "3-1", "1,,3", "1-a", "1-3-5"]) {
      expect(validatePageRangeSyntax(spec)).not.toBeNull();
    }
  });

  it("rejects an empty string", () => {
    expect(validatePageRangeSyntax("")).not.toBeNull();
  });

  it("rejects leading/trailing whitespace (not a documented valid form)", () => {
    expect(validatePageRangeSyntax(" 1")).not.toBeNull();
    expect(validatePageRangeSyntax("1 ")).not.toBeNull();
  });
});

describe("resolvePageRange", () => {
  it("resolves a single page", () => {
    expect(resolvePageRange("3", 10, 700)).toEqual({ ok: true, pages: [3] });
  });

  it("resolves a range", () => {
    expect(resolvePageRange("2-4", 10, 700)).toEqual({ ok: true, pages: [2, 3, 4] });
  });

  it("resolves multiple ranges, in spec order", () => {
    expect(resolvePageRange("1-2,7,4-5", 10, 700)).toEqual({
      ok: true,
      pages: [1, 2, 7, 4, 5],
    });
  });

  it("resolves an open start (-3 = pages 1 through 3)", () => {
    expect(resolvePageRange("-3", 10, 700)).toEqual({ ok: true, pages: [1, 2, 3] });
  });

  it("resolves an open end (5- = page 5 through the last page)", () => {
    expect(resolvePageRange("5-", 7, 700)).toEqual({ ok: true, pages: [5, 6, 7] });
  });

  it('resolves "1-" as all pages', () => {
    expect(resolvePageRange("1-", 4, 700)).toEqual({ ok: true, pages: [1, 2, 3, 4] });
  });

  it("dedupes, keeping only the first occurrence's position", () => {
    expect(resolvePageRange("3,1-3,2", 5, 700)).toEqual({ ok: true, pages: [3, 1, 2] });
  });

  it("rejects a syntactically invalid spec (0 pages)", () => {
    const result = resolvePageRange("0", 10, 700);
    expect(result.ok).toBe(false);
  });

  it("rejects a reversed range", () => {
    const result = resolvePageRange("5-2", 10, 700);
    expect(result.ok).toBe(false);
  });

  it("rejects invalid characters", () => {
    const result = resolvePageRange("1-a", 10, 700);
    expect(result.ok).toBe(false);
  });

  it("rejects a page number beyond the document's page count", () => {
    const result = resolvePageRange("11", 10, 700);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/out of range/);
    }
  });

  it("truncates an open-ended range at the real page count without erroring", () => {
    expect(resolvePageRange("5-", 6, 700)).toEqual({ ok: true, pages: [5, 6] });
  });

  it("enforces the selected-page-count cap", () => {
    const result = resolvePageRange("1-", 1000, 700);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/too many pages/);
    }
  });

  it("accepts exactly the cap", () => {
    const result = resolvePageRange("1-700", 1000, 700);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pages).toHaveLength(700);
    }
  });

  it("rejects a non-positive totalPages", () => {
    const result = resolvePageRange("1", 0, 700);
    expect(result.ok).toBe(false);
  });
});
