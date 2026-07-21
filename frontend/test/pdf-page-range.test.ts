// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isValidPagesSyntax, PageRangeError, resolvePageNumbers } from "../src/lib/pdf-page-range";

describe("isValidPagesSyntax", () => {
  it.each([
    "1", "1-10", "1,3,5", "1-4,7,10-12", "5-", "-3", "1-",
  ])("accepts %s", (spec) => {
    expect(isValidPagesSyntax(spec)).toBe(true);
  });

  it.each([
    "", "0", "-0", "3-1", "1,,3", "1-a", "1-3-5", "a", ",", "1,",
  ])("rejects %s", (spec) => {
    expect(isValidPagesSyntax(spec)).toBe(false);
  });
});

describe("resolvePageNumbers", () => {
  it("resolves a single page", () => {
    expect(resolvePageNumbers("3", 10)).toEqual([3]);
  });

  it("resolves a simple range", () => {
    expect(resolvePageNumbers("2-4", 10)).toEqual([2, 3, 4]);
  });

  it("resolves multiple ranges in declaration order", () => {
    expect(resolvePageNumbers("1-2,7,4-5", 10)).toEqual([1, 2, 7, 4, 5]);
  });

  it("resolves an open start (5-)", () => {
    expect(resolvePageNumbers("5-", 8)).toEqual([5, 6, 7, 8]);
  });

  it("resolves an open end (-3)", () => {
    expect(resolvePageNumbers("-3", 8)).toEqual([1, 2, 3]);
  });

  it("resolves 1- as all pages", () => {
    expect(resolvePageNumbers("1-", 4)).toEqual([1, 2, 3, 4]);
  });

  it("dedupes keeping the first occurrence", () => {
    expect(resolvePageNumbers("1-3,2-5", 10)).toEqual([1, 2, 3, 4, 5]);
  });

  it("ignores page numbers beyond pageCount", () => {
    expect(resolvePageNumbers("8-12", 10)).toEqual([8, 9, 10]);
  });

  it("throws when no pages are selected (fully out of range)", () => {
    expect(() => resolvePageNumbers("20-30", 10)).toThrow(PageRangeError);
  });

  it("throws for reversed ranges", () => {
    expect(() => resolvePageNumbers("5-2", 10)).toThrow(PageRangeError);
  });

  it("throws for page 0", () => {
    expect(() => resolvePageNumbers("0", 10)).toThrow(PageRangeError);
  });

  it("throws for invalid characters", () => {
    expect(() => resolvePageNumbers("1-a", 10)).toThrow(PageRangeError);
  });

  it("throws when the selected page count exceeds the limit", () => {
    expect(() => resolvePageNumbers("1-", 1000, 700)).toThrow(PageRangeError);
  });

  it("accepts exactly the max selected pages", () => {
    expect(resolvePageNumbers("1-700", 1000, 700)).toHaveLength(700);
  });
});
