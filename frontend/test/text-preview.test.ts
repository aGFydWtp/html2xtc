// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { PREVIEW_MAX_CHARS, PREVIEW_TARGET_CHARS, selectTextPreview } from "../src/lib/text-preview";

describe("selectTextPreview (実装仕様書 §5.1)", () => {
  it("returns the full text when at or under PREVIEW_TARGET_CHARS", () => {
    const text = "a".repeat(PREVIEW_TARGET_CHARS);
    expect(selectTextPreview(text)).toBe(text);
  });

  it("returns the full text for text well under the target", () => {
    expect(selectTextPreview("short body")).toBe("short body");
  });

  it("extends to the first paragraph break at or after PREVIEW_TARGET_CHARS", () => {
    const before = "a".repeat(PREVIEW_TARGET_CHARS + 100);
    const after = "tail paragraph content";
    const text = `${before}\n\n${after}\n\nmore text after that`;
    const result = selectTextPreview(text);
    expect(result).toBe(before);
  });

  it("does not extend past PREVIEW_MAX_CHARS even if a paragraph break exists just beyond it", () => {
    const before = "a".repeat(PREVIEW_MAX_CHARS + 50);
    const text = `${before}\n\ntail`;
    const result = selectTextPreview(text);
    expect(Array.from(result).length).toBe(PREVIEW_MAX_CHARS);
    expect(result).toBe("a".repeat(PREVIEW_MAX_CHARS));
  });

  it("cuts at exactly PREVIEW_MAX_CHARS when no paragraph break exists at all", () => {
    const text = "a".repeat(PREVIEW_MAX_CHARS + 500); // one giant paragraph
    const result = selectTextPreview(text);
    expect(Array.from(result).length).toBe(PREVIEW_MAX_CHARS);
  });

  it("normalizes CRLF (and bare CR) to LF before extracting", () => {
    const before = "a".repeat(PREVIEW_TARGET_CHARS + 10);
    const text = `${before}\r\n\r\ntail`;
    const result = selectTextPreview(text);
    expect(result).toBe(before);
    expect(result).not.toContain("\r");
  });

  it("never splits a surrogate pair (emoji) at the PREVIEW_MAX_CHARS boundary", () => {
    // Each emoji is one code point / two UTF-16 units. Fill up to exactly
    // one code point short of the cap with ASCII, then add an emoji that
    // would straddle the boundary if cut in UTF-16 units instead of code
    // points.
    const filler = "a".repeat(PREVIEW_MAX_CHARS - 1);
    const text = `${filler}\u{1F600}\u{1F601}extra content after`; // no paragraph break at all
    const result = selectTextPreview(text);
    expect(Array.from(result).length).toBe(PREVIEW_MAX_CHARS);
    // The lone surrogate pair that lands exactly on the boundary must be
    // kept whole, not split into a lone (invalid) surrogate half.
    expect(result.endsWith("\u{1F600}")).toBe(true);
  });

  it("returns an empty string for empty input", () => {
    expect(selectTextPreview("")).toBe("");
  });

  it("returns whitespace-only input unchanged when under the target", () => {
    expect(selectTextPreview("   \n\n   ")).toBe("   \n\n   ");
  });

  it("trims a trailing run of spaces/tabs left dangling by a hard PREVIEW_MAX_CHARS cut", () => {
    // Construct text so the exact PREVIEW_MAX_CHARS-th character lands in the
    // middle of a run of trailing spaces within the final line (no paragraph
    // break anywhere), then confirm the cut result has no trailing
    // space/tab — only whichever whitespace fell inside the cut is trimmed,
    // the line's own newline structure elsewhere is untouched.
    const body = "a".repeat(PREVIEW_MAX_CHARS - 5) + "     " + "b".repeat(50);
    const result = selectTextPreview(body);
    expect(Array.from(result).length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(result).not.toMatch(/[ \t]$/);
  });
});
