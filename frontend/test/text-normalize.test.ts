// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  countCharacters,
  countLines,
  escapeHtml,
  joinWrappedLines,
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
    expect(normalizeText("a\r\nb\rc\nd", { maxConsecutiveBlankLines: 5, preserveSpaces: false, joinHardWrappedLines: false }).text).toBe("a\nb\nc\nd");
  });

  it("normalizes to NFC (not NFKC)", () => {
    // "が" as base + combining dakuten (NFD) should combine to the precomposed NFC form.
    const nfd = "が";
    const result = normalizeText(nfd, { maxConsecutiveBlankLines: 5, preserveSpaces: false, joinHardWrappedLines: false });
    expect(result.text).toBe("が");
    expect(result.text.normalize("NFC")).toBe(result.text);
  });

  it("strips disallowed control characters and counts them, keeping LF and TAB", () => {
    const raw = "a\u0000b\u000Bc\u000Cd\u001Fe\u007Ff\tg\nh";
    const result = normalizeText(raw, { maxConsecutiveBlankLines: 5, preserveSpaces: true, joinHardWrappedLines: false });
    expect(result.text).toBe("abcdef\tg\nh");
    expect(result.controlCharsRemoved).toBe(5);
  });

  it("trims trailing line whitespace when preserveSpaces is false", () => {
    const raw = "line1   \t \nline2\t";
    expect(normalizeText(raw, { maxConsecutiveBlankLines: 5, preserveSpaces: false, joinHardWrappedLines: false }).text).toBe("line1\nline2");
  });

  it("keeps trailing whitespace when preserveSpaces is true", () => {
    const raw = "line1   \nline2\t";
    expect(normalizeText(raw, { maxConsecutiveBlankLines: 5, preserveSpaces: true, joinHardWrappedLines: false }).text).toBe("line1   \nline2\t");
  });

  it("treats whitespace-only lines as blank and limits consecutive blank lines", () => {
    const raw = "a\n\n\n\n \n\nb"; // several blank/whitespace-only lines in a row
    const result = normalizeText(raw, { maxConsecutiveBlankLines: 2, preserveSpaces: false, joinHardWrappedLines: false });
    expect(result.text).toBe("a\n\n\nb");
  });

  it("maxConsecutiveBlankLines=0 removes all blank lines", () => {
    const raw = "a\n\n\nb";
    expect(normalizeText(raw, { maxConsecutiveBlankLines: 0, preserveSpaces: false, joinHardWrappedLines: false }).text).toBe("a\nb");
  });
});

describe("joinWrappedLines: sentence/quotation-end characters keep the break", () => {
  it.each([
    ["。", "行A。\n行B"],
    ["！", "行A！\n行B"],
    ["？", "行A？\n行B"],
    ["…", "行A…\n行B"],
    ["‥", "行A‥\n行B"],
    ["」", "「行A」\n行B"],
    ["』", "『行A』\n行B"],
    ["）", "（行A）\n行B"],
    ["】", "【行A】\n行B"],
    ["〕", "〔行A〕\n行B"],
    ["〉", "〈行A〉\n行B"],
    ["》", "《行A》\n行B"],
    [".", "line A.\nline B"],
    ["!", "line A!\nline B"],
    ["?", "line A?\nline B"],
  ])("keeps the break when a line ends with %s", (_char, text) => {
    expect(joinWrappedLines(text)).toBe(text);
  });
});

describe("joinWrappedLines: paragraph-head markers on the next line keep the break", () => {
  it.each([
    ["full-width space", "行A\n　行B"],
    ["tab", "行A\n\t行B"],
    ["「", "行A\n「行B"],
    ["『", "行A\n『行B"],
    ["（", "行A\n（行B"],
    ["〈", "行A\n〈行B"],
    ["《", "行A\n《行B"],
    ["【", "行A\n【行B"],
  ])("keeps the break when the next line starts with a %s marker", (_label, text) => {
    expect(joinWrappedLines(text)).toBe(text);
  });
});

describe("joinWrappedLines: joins hard-wrapped lines otherwise", () => {
  it("joins Japanese lines with no separator (no ASCII join boundary)", () => {
    expect(joinWrappedLines("これは長い文章の\n途中で改行されている")).toBe(
      "これは長い文章の途中で改行されている",
    );
  });

  it("joins ASCII word-wrapped lines with a single space", () => {
    expect(joinWrappedLines("This is a line\nthat keeps going")).toBe(
      "This is a line that keeps going",
    );
  });

  it("joins with a space when A ends with one of the allowed ASCII join chars", () => {
    expect(joinWrappedLines("see items 1,\n2, and 3")).toBe("see items 1, 2, and 3");
    expect(joinWrappedLines("(see below)\ncontinued")).toBe("(see below) continued");
  });

  it("does not insert a space when only one side is ASCII", () => {
    expect(joinWrappedLines("日本語では\nEnglish word")).toBe("日本語ではEnglish word");
  });

  it("strips A's trailing space/tab before joining", () => {
    expect(joinWrappedLines("行A  \n行B")).toBe("行A行B");
    expect(joinWrappedLines("word  \nnext")).toBe("word next");
  });

  it("joins across more than two consecutive hard-wrapped lines", () => {
    expect(joinWrappedLines("あいうえお\nかきくけこ\nさしすせそ")).toBe(
      "あいうえおかきくけこさしすせそ",
    );
  });

  it("keeps paragraph separators (blank lines) intact and joins within each paragraph independently", () => {
    const text = "段落一の\n行A\n\n段落二の\n行B";
    expect(joinWrappedLines(text)).toBe("段落一の行A\n\n段落二の行B");
  });

  it("preserves multi-blank-line separators as-is", () => {
    const text = "段落一\n\n\n段落二";
    expect(joinWrappedLines(text)).toBe(text);
  });

  it("leaves an empty line boundary alone (A or B empty)", () => {
    expect(joinWrappedLines("\n行B")).toBe("\n行B");
  });
});

describe("normalizeText: joinHardWrappedLines integration", () => {
  it("joins hard-wrapped lines when true", () => {
    const text = "これは長い文章の\n途中で改行されている。\n次の文もある";
    const result = normalizeText(text, {
      maxConsecutiveBlankLines: 5,
      preserveSpaces: false,
      joinHardWrappedLines: true,
    });
    expect(result.text).toBe("これは長い文章の途中で改行されている。\n次の文もある");
  });

  it("keeps every line break when false (current/legacy behavior)", () => {
    const text = "これは長い文章の\n途中で改行されている。\n次の文もある";
    const result = normalizeText(text, {
      maxConsecutiveBlankLines: 5,
      preserveSpaces: false,
      joinHardWrappedLines: false,
    });
    expect(result.text).toBe(text);
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
