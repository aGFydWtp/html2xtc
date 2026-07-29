// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isResolutionMismatch, type Resolution } from "../src/lib/resolution-mismatch";

const X3: Resolution = { width: 528, height: 792 };
const X4: Resolution = { width: 480, height: 800 };
const UNKNOWN: Resolution = { width: null, height: null };

describe("isResolutionMismatch", () => {
  it("returns false when both resolutions match", () => {
    expect(isResolutionMismatch(X3, { width: 528, height: 792 })).toBe(false);
  });

  it("returns true when resolutions differ", () => {
    expect(isResolutionMismatch(X3, X4)).toBe(true);
  });

  it("returns false when the device side has a null width (unknown device)", () => {
    expect(isResolutionMismatch({ width: null, height: 792 }, X4)).toBe(false);
  });

  it("returns false when the device side has a null height (unknown device)", () => {
    expect(isResolutionMismatch({ width: 528, height: null }, X4)).toBe(false);
  });

  it("returns false when the device side is fully unknown (both null)", () => {
    expect(isResolutionMismatch(UNKNOWN, X4)).toBe(false);
  });

  it("returns false when the item side cannot be resolved (missing metadata)", () => {
    expect(isResolutionMismatch(X3, UNKNOWN)).toBe(false);
  });
});
