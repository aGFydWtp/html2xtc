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

  it("defaults to the plain behavior when inputFormat is explicitly \"plain\"", () => {
    const before = "a".repeat(PREVIEW_TARGET_CHARS + 100);
    const text = `${before}\n\ntail`;
    expect(selectTextPreview(text, "plain")).toBe(selectTextPreview(text));
  });
});

// --- aozora (aozora-text-conversion 仕様書 §14.2) ---------------------------------

describe("selectTextPreview — inputFormat: \"aozora\"", () => {
  it("returns the full body unchanged when under the target, with no header/footer to strip", () => {
    expect(selectTextPreview("短い本文です。", "aozora")).toBe("短い本文です。");
  });

  it("separates the standard header (表題/著者) and never re-includes it in the extracted body", () => {
    const text = [
      "吾輩は猫である",
      "夏目漱石",
      "-------------------------------------------------------",
      "本文がここから始まる。",
    ].join("\n");
    const result = selectTextPreview(text, "aozora");
    expect(result).not.toContain("夏目漱石");
    expect(result).not.toContain("吾輩は猫である");
    expect(result).toBe("本文がここから始まる。");
  });

  it("separates a recognized 底本 footer out of the extracted body", () => {
    const text = [
      "本文がここにある。",
      "",
      "",
      "底本：「吾輩は猫である」岩波書店",
      "初出：「ホトトギス」",
    ].join("\n");
    const result = selectTextPreview(text, "aozora");
    expect(result).not.toContain("底本：");
    expect(result).not.toContain("初出：");
    expect(result).toContain("本文がここにある。");
  });

  it("never cuts in the middle of a 《...》 ruby annotation", () => {
    const filler = "本文".repeat(Math.ceil((PREVIEW_MAX_CHARS - 10) / 2));
    const text = `${filler}彼は倫敦《ロンドン》に住んでいた。`;
    const result = selectTextPreview(text, "aozora");
    // Either the ruby span is fully included, or fully excluded — never
    // truncated mid-way (no lone "《" without its matching "》").
    const openCount = (result.match(/《/g) ?? []).length;
    const closeCount = (result.match(/》/g) ?? []).length;
    expect(openCount).toBe(closeCount);
  });

  it("never cuts in the middle of a ［＃...］ annotation", () => {
    const filler = "本文".repeat(Math.ceil((PREVIEW_MAX_CHARS - 10) / 2));
    const text = `${filler}［＃3字下げ］見出し的な一文`;
    const result = selectTextPreview(text, "aozora");
    const openCount = (result.match(/［＃/g) ?? []).length;
    const closeCount = (result.match(/］/g) ?? []).length;
    expect(openCount).toBe(closeCount);
  });

  it("backs off to before an unclosed range-start annotation (ここから…ここで…終わり not yet closed)", () => {
    const filler = "本文".repeat(Math.ceil((PREVIEW_MAX_CHARS - 20) / 2));
    // The range never closes within the extracted window at all.
    const text = `${filler}［＃ここから2字下げ］` + "字下げされた本文".repeat(20);
    const result = selectTextPreview(text, "aozora");
    expect(result).not.toContain("ここから2字下げ");
    expect(result.endsWith(filler)).toBe(true);
  });

  it("keeps a range annotation that opens and fully closes within the extracted window", () => {
    // Same paragraph as the filler (single newline / no gap) so the range
    // itself isn't excluded by the ordinary paragraph-break cutoff — the
    // first blank-line run in the [TARGET, MAX) window is the one after the
    // range's own closing bracket, not one splitting the range in half.
    const filler = "本文".repeat(Math.ceil((PREVIEW_TARGET_CHARS + 10) / 2));
    const text = `${filler}［＃ここから2字下げ］字下げされた一文［＃ここで字下げ終わり］\n\n次の段落。`;
    const result = selectTextPreview(text, "aozora");
    expect(result).toContain("ここから2字下げ");
    expect(result).toContain("ここで字下げ終わり");
    expect(result).not.toContain("次の段落");
  });

  it("prefers a line-end boundary over a hard mid-line cut when no paragraph break exists", () => {
    // One giant paragraph (no blank-line run anywhere) but with internal
    // single newlines — the cutoff should still prefer to land right after
    // one of those internal line breaks rather than mid-line.
    const line = "あ".repeat(50);
    const lines = Array.from({ length: 30 }, () => line);
    const text = lines.join("\n");
    const result = selectTextPreview(text, "aozora");
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    // The result must not end with a trailing newline (excluded by
    // construction), and the very next character in the source at the cut
    // point must be a newline — proof the cut landed at a real line
    // boundary rather than mid-line.
    expect(result.endsWith("\n")).toBe(false);
    expect(text[Array.from(result).length]).toBe("\n");
  });

  it("returns an empty string when the whole input is header/footer with no body", () => {
    const text = ["表題", "著者", "-----------------------------"].join("\n");
    expect(selectTextPreview(text, "aozora")).toBe("");
  });
});

// --- markdown (Markdown対応仕様書 §18) --------------------------------------------

describe('selectTextPreview — inputFormat: "markdown"', () => {
  it("behaves like plain text when there is no fenced code block", () => {
    const before = "a".repeat(PREVIEW_TARGET_CHARS + 100);
    const text = `${before}\n\ntail`;
    expect(selectTextPreview(text, "markdown")).toBe(before);
  });

  it("returns the full text unchanged when at or under the target, even with a fence inside", () => {
    const text = "intro\n\n```\ncode\n```\n\noutro";
    expect(selectTextPreview(text, "markdown")).toBe(text);
  });

  it("extends past the normal cutoff to include a fence that closes within the search limit (§18 rule 1-2)", () => {
    const prefix = "b".repeat(700) + "\n";
    const codeLines = Array.from({ length: 40 }, (_, i) => `code line ${i}`).join("\n");
    const text = `${prefix}\`\`\`\n${codeLines}\n\`\`\`\n\nSTOP_AFTER_FENCE`;
    const result = selectTextPreview(text, "markdown");
    expect(result).not.toContain("STOP_AFTER_FENCE");
    // Both the opening and the matching closing fence markers are present —
    // the cutoff was extended through the close, not truncated mid-block.
    expect((result.match(/```/g) ?? []).length).toBe(2);
    expect(result.trimEnd().endsWith("```")).toBe(true);
  });

  it("recognizes ~~~ fences the same way as ``` fences", () => {
    const prefix = "b".repeat(700) + "\n";
    const codeLines = Array.from({ length: 40 }, (_, i) => `code line ${i}`).join("\n");
    const text = `${prefix}~~~\n${codeLines}\n~~~\n\nSTOP_AFTER_FENCE`;
    const result = selectTextPreview(text, "markdown");
    expect(result).not.toContain("STOP_AFTER_FENCE");
    expect((result.match(/~~~/g) ?? []).length).toBe(2);
  });

  it("backs off to before the opening fence when no closing fence is found within the search limit (§18 rule 3)", () => {
    const prefix = "c".repeat(700) + "\n";
    const unclosedCode = "z".repeat(6000); // one giant line, never closes, well past the 4,000cp search limit
    const text = `${prefix}\`\`\`\n${unclosedCode}`;
    const result = selectTextPreview(text, "markdown");
    expect(result).not.toContain("```");
    // Trimmed back to just before the opening fence line (prefix, "700 c's" + its own newline).
    expect(Array.from(result).length).toBeLessThanOrEqual(Array.from(prefix).length);
  });

  it("only treats a same-or-longer, same-character run as the closing fence — a shorter run inside the block is ignored (§18 rule 4-5)", () => {
    const prefix = "d".repeat(700) + "\n";
    const codeLines = Array.from({ length: 20 }, (_, i) => (i === 5 ? "```" : `code ${i}`)).join("\n");
    const text = `${prefix}\`\`\`\`\n${codeLines}\n\`\`\`\`\n\nSTOP_AFTER_FENCE`;
    const result = selectTextPreview(text, "markdown");
    expect(result).not.toContain("STOP_AFTER_FENCE");
    // The fake 3-backtick "close" inside the block must not have ended the
    // fence early — the block content up to and including the real 4-tick
    // close is all present.
    expect(result).toContain("code 19");
    expect(result.endsWith("````")).toBe(true);
  });

  it("never splits a surrogate pair (emoji) at the cutoff boundary, same as plain", () => {
    const filler = "a".repeat(PREVIEW_MAX_CHARS - 1);
    const text = `${filler}\u{1F600}\u{1F601}extra content after`;
    const result = selectTextPreview(text, "markdown");
    expect(Array.from(result).length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(result.endsWith("\u{1F600}") || Array.from(result).length < PREVIEW_MAX_CHARS).toBe(true);
  });

  it("returns an empty string for empty input", () => {
    expect(selectTextPreview("", "markdown")).toBe("");
  });
});
