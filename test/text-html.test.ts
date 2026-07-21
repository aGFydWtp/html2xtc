// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_OPTIONS } from "../src/text-options";
import {
  buildTextArticleHtml,
  buildTextPrintCss,
  escapeHtml,
  resolveDocumentTitle,
  textToParagraphHtml,
} from "../src/text-html";

describe("escapeHtml", () => {
  it("escapes the five HTML-sensitive characters", () => {
    expect(escapeHtml(`<script>alert(1)</script> & "quote" 'apos'`)).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quote&quot; &#39;apos&#39;",
    );
  });

  it("passes plain text through unchanged", () => {
    expect(escapeHtml("吾輩は猫である。")).toBe("吾輩は猫である。");
  });
});

describe("textToParagraphHtml", () => {
  it("never interprets HTML tags in the body", () => {
    const html = textToParagraphHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never interprets Markdown syntax", () => {
    const html = textToParagraphHtml("# 見出し\n**強調**");
    expect(html).toContain("# 見出し");
    expect(html).toContain("**強調**");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<strong>");
  });

  it("splits blank-line-separated blocks into paragraphs", () => {
    const html = textToParagraphHtml("first paragraph\n\nsecond paragraph");
    expect(html).toBe("<p>first paragraph</p>\n<p>second paragraph</p>");
  });

  it("converts a single newline within a paragraph to <br>", () => {
    const html = textToParagraphHtml("line one\nline two");
    expect(html).toBe("<p>line one<br>line two</p>");
  });

  it("escapes ampersands and quotes inside paragraph text", () => {
    const html = textToParagraphHtml('A & B "quoted"');
    expect(html).toBe('<p>A &amp; B &quot;quoted&quot;</p>');
  });
});

describe("resolveDocumentTitle", () => {
  it("prefers options.title", () => {
    expect(resolveDocumentTitle("表題", "novel.txt")).toBe("表題");
  });

  it("falls back to the filename with .txt stripped", () => {
    expect(resolveDocumentTitle("", "my-novel.txt")).toBe("my-novel");
  });

  it("falls back to Untitled when both are empty", () => {
    expect(resolveDocumentTitle("", "")).toBe("Untitled");
    expect(resolveDocumentTitle("   ", ".txt")).toBe("Untitled");
  });

  it("trims whitespace-only titles before falling back", () => {
    expect(resolveDocumentTitle("   ", "doc.txt")).toBe("doc");
  });
});

describe("buildTextPrintCss", () => {
  it("emits the fixed 528x792 CSS-px page geometry with the options' margins", () => {
    const css = buildTextPrintCss(DEFAULT_TEXT_OPTIONS);
    expect(css).toContain("size: 528px 792px;");
    expect(css).toContain("margin: var(--margin-top) var(--margin-right) var(--margin-bottom) var(--margin-left);");
    expect(css).toContain("--margin-top: 36px;");
    expect(css).toContain("--margin-right: 32px;");
    expect(css).toContain("--margin-bottom: 40px;");
    expect(css).toContain("--margin-left: 32px;");
  });

  it("binds font/size/line-height/paragraph-spacing custom properties to the options", () => {
    const css = buildTextPrintCss({
      ...DEFAULT_TEXT_OPTIONS,
      font: "Noto Sans JP",
      fontSizePx: 23,
      lineHeight: 2.1,
      paragraphSpacingEm: 1.2,
    });
    expect(css).toContain('--font-family: "Noto Sans JP", sans-serif;');
    expect(css).toContain("--font-size: 23px;");
    expect(css).toContain("--line-height: 2.1;");
    expect(css).toContain("--paragraph-spacing: 1.2em;");
  });

  it("emits horizontal-tb writing mode for horizontal layout", () => {
    const css = buildTextPrintCss({ ...DEFAULT_TEXT_OPTIONS, layout: "horizontal" });
    expect(css).toContain("writing-mode: horizontal-tb;");
    expect(css).toContain('--font-family: "BIZ UDPGothic", sans-serif;');
  });

  it("emits vertical-rl writing mode on the root element for vertical layout", () => {
    const css = buildTextPrintCss({ ...DEFAULT_TEXT_OPTIONS, layout: "vertical" });
    // 入れ子要素への writing-mode 指定は Chromium の印刷ページ分割で2ページ目
    // 以降が白紙になるため、必ず html（ルート）に付ける（src/text-html.ts）。
    expect(css).toMatch(/html \{\s*writing-mode: vertical-rl;/);
    expect(css).toContain('--font-family: "BIZ UDPGothic", serif;');
    expect(css).not.toContain("height: 100%;");
  });

  it("adds justify + inter-character rules only when textAlign is justify", () => {
    const justified = buildTextPrintCss({ ...DEFAULT_TEXT_OPTIONS, textAlign: "justify" });
    expect(justified).toContain("text-align: justify;");
    expect(justified).toContain("text-justify: inter-character;");
    const start = buildTextPrintCss({ ...DEFAULT_TEXT_OPTIONS, textAlign: "start" });
    expect(start).not.toContain("text-justify");
  });

  it("applies justify under vertical layout too", () => {
    const css = buildTextPrintCss({
      ...DEFAULT_TEXT_OPTIONS,
      layout: "vertical",
      textAlign: "justify",
    });
    expect(css).toContain("text-justify: inter-character;");
    expect(css).toContain("writing-mode: vertical-rl;");
  });

  it("adds white-space: pre-wrap and tab-size only when preserveSpaces is true", () => {
    const preserved = buildTextPrintCss({ ...DEFAULT_TEXT_OPTIONS, preserveSpaces: true });
    expect(preserved).toContain("white-space: pre-wrap;");
    expect(preserved).toContain("tab-size: 4;");
    const notPreserved = buildTextPrintCss({ ...DEFAULT_TEXT_OPTIONS, preserveSpaces: false });
    expect(notPreserved).not.toContain("white-space: pre-wrap;");
  });
});

describe("buildTextArticleHtml", () => {
  it("never references any external URL, script, or stylesheet", () => {
    const html = buildTextArticleHtml({
      normalizedText: "本文です。",
      options: DEFAULT_TEXT_OPTIONS,
      documentTitle: "テスト",
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\bsrc=/i);
  });

  it("sets the Content-Security-Policy meta tag (spec §17.1)", () => {
    const html = buildTextArticleHtml({
      normalizedText: "本文",
      options: DEFAULT_TEXT_OPTIONS,
      documentTitle: "T",
    });
    expect(html).toContain(
      `content="default-src 'none'; style-src 'unsafe-inline'; font-src data:;"`,
    );
  });

  it("uses the resolved document title for <title>, HTML-escaped", () => {
    const html = buildTextArticleHtml({
      normalizedText: "本文",
      options: DEFAULT_TEXT_OPTIONS,
      documentTitle: `A & <B>`,
    });
    expect(html).toContain("<title>A &amp; &lt;B&gt;</title>");
  });

  it("omits book-header when both title and author are empty", () => {
    const html = buildTextArticleHtml({
      normalizedText: "本文",
      options: DEFAULT_TEXT_OPTIONS,
      documentTitle: "Untitled",
    });
    expect(html).not.toContain("book-header");
  });

  it("renders book-header with title and author when either is set", () => {
    const withTitle = buildTextArticleHtml({
      normalizedText: "本文",
      options: { ...DEFAULT_TEXT_OPTIONS, title: "小説のタイトル" },
      documentTitle: "小説のタイトル",
    });
    expect(withTitle).toContain('<header class="book-header">');
    expect(withTitle).toContain("<h1>小説のタイトル</h1>");
    expect(withTitle).not.toContain('<p class="author">');

    const withAuthor = buildTextArticleHtml({
      normalizedText: "本文",
      options: { ...DEFAULT_TEXT_OPTIONS, author: "著者名" },
      documentTitle: "Untitled",
    });
    expect(withAuthor).toContain('<header class="book-header">');
    expect(withAuthor).toContain('<p class="author">著者名</p>');
    expect(withAuthor).not.toContain("<h1>");
  });

  it("escapes title/author in the header", () => {
    const html = buildTextArticleHtml({
      normalizedText: "本文",
      options: { ...DEFAULT_TEXT_OPTIONS, title: "<b>T</b>", author: "<i>A</i>" },
      documentTitle: "<b>T</b>",
    });
    expect(html).toContain("<h1>&lt;b&gt;T&lt;/b&gt;</h1>");
    expect(html).toContain('<p class="author">&lt;i&gt;A&lt;/i&gt;</p>');
  });

  it("includes the paragraph HTML for the body", () => {
    const html = buildTextArticleHtml({
      normalizedText: "第一段落\n\n第二段落",
      options: DEFAULT_TEXT_OPTIONS,
      documentTitle: "T",
    });
    expect(html).toContain("<p>第一段落</p>");
    expect(html).toContain("<p>第二段落</p>");
  });

  it("declares lang=ja and utf-8 charset", () => {
    const html = buildTextArticleHtml({
      normalizedText: "本文",
      options: DEFAULT_TEXT_OPTIONS,
      documentTitle: "T",
    });
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('<meta charset="utf-8">');
  });
});
