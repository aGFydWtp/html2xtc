import { describe, expect, it } from "vitest";
import { isValidItemId, isValidJobId } from "../src/library/service";

const VALID_UUID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

describe("isValidJobId", () => {
  it("accepts a well-formed UUID", () => {
    expect(isValidJobId(VALID_UUID)).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    for (const value of ["", "not-a-uuid", "12345", VALID_UUID.toUpperCase(), `${VALID_UUID}x`]) {
      expect(isValidJobId(value)).toBe(false);
    }
  });

  it("rejects path-traversal-shaped input (must never reach an R2 key unvalidated)", () => {
    expect(isValidJobId("../../etc/passwd")).toBe(false);
  });
});

describe("isValidItemId", () => {
  it("accepts a well-formed UUID", () => {
    expect(isValidItemId(VALID_UUID)).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isValidItemId("item-1")).toBe(false);
  });
});
