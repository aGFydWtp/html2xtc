// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  countCharacters,
  countLines,
  escapeHtml,
  normalizeText,
  textToParagraphHtml,
} from "../src/lib/text-normalize";

describe("escapeHtml (§4.1)", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<script>alert(1)</script> & "quote" 'apos'`)).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quote&quot; &#39;apos&#39;",
    );
  });

  it("treats markdown-like syntax as plain text", () => {
    expect(escapeHtml("# 見出し\n**強調**")).toBe("# 見出し\n**強調**");
  });
});

describe("normalizeText (§8)", () => {
  it("normalizes CRLF and CR to LF", () => {
    expect(normalizeText("a\r\nb\rc\nd", { maxConsecutiveBlankLines: 5, preserveSpaces: false }).text).toBe("a\nb\nc\nd");
  });

  it("normalizes to NFC (not NFKC)", () => {
    // "が" as base + combining dakuten (NFD) should combine to the precomposed NFC form.
    const nfd = "が";
    const result = normalizeText(nfd, { maxConsecutiveBlankLines: 5, preserveSpaces: false });
    expect(result.text).toBe("が");
    expect(result.text.normalize("NFC")).toBe(result.text);
  });

  it("strips disallowed control characters and counts them, keeping LF and TAB", () => {
    const raw = "a\u0000b\u000Bc\u000Cd\u001Fe\u007Ff\tg\nh";
    const result = normalizeText(raw, { maxConsecutiveBlankLines: 5, preserveSpaces: true });
    expect(result.text).toBe("abcdef\tg\nh");
    expect(result.controlCharsRemoved).toBe(5);
  });

  it("trims trailing line whitespace when preserveSpaces is false", () => {
    const raw = "line1   \t \nline2\t";
    expect(normalizeText(raw, { maxConsecutiveBlankLines: 5, preserveSpaces: false }).text).toBe("line1\nline2");
  });

  it("keeps trailing whitespace when preserveSpaces is true", () => {
    const raw = "line1   \nline2\t";
    expect(normalizeText(raw, { maxConsecutiveBlankLines: 5, preserveSpaces: true }).text).toBe("line1   \nline2\t");
  });

  it("treats whitespace-only lines as blank and limits consecutive blank lines", () => {
    const raw = "a\n\n\n\n \n\nb"; // several blank/whitespace-only lines in a row
    const result = normalizeText(raw, { maxConsecutiveBlankLines: 2, preserveSpaces: false });
    expect(result.text).toBe("a\n\n\nb");
  });

  it("maxConsecutiveBlankLines=0 removes all blank lines", () => {
    const raw = "a\n\n\nb";
    expect(normalizeText(raw, { maxConsecutiveBlankLines: 0, preserveSpaces: false }).text).toBe("a\nb");
  });
});

describe("textToParagraphHtml (§9.2)", () => {
  it("splits on 2+ consecutive newlines into paragraphs, keeping single newlines as <br>", () => {
    const html = textToParagraphHtml("para one line one\npara one line two\n\npara two");
    expect(html).toBe("<p>para one line one<br>para one line two</p>\n<p>para two</p>");
  });

  it("escapes HTML-sensitive characters inside paragraphs", () => {
    const html = textToParagraphHtml("<b>bold</b> & 'quote'");
    expect(html).toBe("<p>&lt;b&gt;bold&lt;/b&gt; &amp; &#39;quote&#39;</p>");
  });

  it("handles a single paragraph with no blank-line separators", () => {
    expect(textToParagraphHtml("just one paragraph")).toBe("<p>just one paragraph</p>");
  });
});

describe("countCharacters / countLines", () => {
  it("counts by code point, not UTF-16 code unit", () => {
    // U+1F600 (😀) is a single code point but 2 UTF-16 code units.
    expect(countCharacters("a😀b")).toBe(3);
    expect("a😀b".length).toBe(4); // sanity check: differs from code-point count
  });

  it("counts lines by number of LF-delimited segments", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a")).toBe(1);
    expect(countLines("")).toBe(0);
  });
});
