import { describe, expect, it } from "vitest";
import { buildLikePattern } from "../src/opds/search";

describe("buildLikePattern", () => {
  it("wraps a plain query in wildcards", () => {
    expect(buildLikePattern("cat")).toBe("%cat%");
  });

  it("escapes a literal % so it is matched literally, not as a wildcard", () => {
    expect(buildLikePattern("100%")).toBe("%100\\%%");
  });

  it("escapes a literal _ so it is matched literally, not as a single-char wildcard", () => {
    expect(buildLikePattern("a_b")).toBe("%a\\_b%");
  });

  it("escapes a literal backslash before escaping % and _", () => {
    expect(buildLikePattern("a\\b")).toBe("%a\\\\b%");
  });

  it("passes Japanese text through untouched aside from the wrapping wildcards", () => {
    expect(buildLikePattern("吾輩は猫である")).toBe("%吾輩は猫である%");
  });
});
