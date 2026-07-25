// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_OPTIONS } from "../src/text-options";
import { prepareTextDocument } from "../src/text-prepare";
import { buildTextArticleHtml } from "../src/text-html";
import { normalizeText } from "../src/text-normalize";

describe("prepareTextDocument — inputFormat omission (backward compatibility)", () => {
  it("treats an options object without inputFormat the same as inputFormat: plain", () => {
    const { inputFormat: _omitted, ...withoutInputFormat } = DEFAULT_TEXT_OPTIONS;
    const withPlain = prepareTextDocument({
      decodedText: "第一段落\n\n第二段落",
      filename: "novel.txt",
      // Cast: exercising the historical shape (no inputFormat key at all),
      // exactly like a payload/header saved before this field existed.
      options: withoutInputFormat as typeof DEFAULT_TEXT_OPTIONS,
    });
    const withExplicitPlain = prepareTextDocument({
      decodedText: "第一段落\n\n第二段落",
      filename: "novel.txt",
      options: { ...DEFAULT_TEXT_OPTIONS, inputFormat: "plain" },
    });
    expect(withPlain.html).toBe(withExplicitPlain.html);
  });
});

describe("prepareTextDocument — plain output parity with buildTextArticleHtml", () => {
  it("produces byte-identical html to the existing normalizeText→resolveDocumentTitle→buildTextArticleHtml pipeline", () => {
    const decodedText = "表題を含まない本文です。\n\n二つ目の段落。\r\nCRLFも混ざる。";
    const options = { ...DEFAULT_TEXT_OPTIONS, title: "小説", author: "著者名" };
    const filename = "my-novel.txt";

    const prepared = prepareTextDocument({ decodedText, filename, options });

    const normalized = normalizeText(decodedText, {
      maxConsecutiveBlankLines: options.maxConsecutiveBlankLines,
      preserveSpaces: options.preserveSpaces,
      joinHardWrappedLines: options.joinHardWrappedLines,
    });
    const documentTitle = "小説"; // resolveDocumentTitle(options.title, filename)
    const expectedHtml = buildTextArticleHtml({
      normalizedText: normalized.text,
      options,
      documentTitle,
    });

    expect(prepared.html).toBe(expectedHtml);
    expect(prepared.documentTitle).toBe(documentTitle);
    expect(prepared.author).toBe("著者名");
  });

  it("falls back to the filename and Untitled exactly like resolveDocumentTitle", () => {
    const prepared = prepareTextDocument({
      decodedText: "本文",
      filename: "my-novel.txt",
      options: DEFAULT_TEXT_OPTIONS,
    });
    expect(prepared.documentTitle).toBe("my-novel");

    const preparedNoName = prepareTextDocument({
      decodedText: "本文",
      filename: "",
      options: DEFAULT_TEXT_OPTIONS,
    });
    expect(preparedNoName.documentTitle).toBe("Untitled");
  });

  it("reports zero diagnostics for plain input", () => {
    const prepared = prepareTextDocument({
      decodedText: "本文",
      filename: "a.txt",
      options: DEFAULT_TEXT_OPTIONS,
    });
    expect(prepared.diagnostics).toEqual({
      recognizedAnnotations: 0,
      unsupportedAnnotations: 0,
      malformedAnnotations: 0,
      truncatedDiagnostics: false,
    });
  });
});

describe("prepareTextDocument — plain never interprets HTML/Markdown/aozora notation", () => {
  it("escapes an HTML payload as literal characters", () => {
    const prepared = prepareTextDocument({
      decodedText: "<script>alert(1)</script>",
      filename: "a.txt",
      options: DEFAULT_TEXT_OPTIONS,
    });
    expect(prepared.html).not.toContain("<script>alert(1)</script>");
    expect(prepared.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps Markdown syntax as literal characters", () => {
    const prepared = prepareTextDocument({
      decodedText: "# 見出し\n**強調**",
      filename: "a.txt",
      options: DEFAULT_TEXT_OPTIONS,
    });
    expect(prepared.html).toContain("# 見出し");
    expect(prepared.html).toContain("**強調**");
    expect(prepared.html).not.toContain("<h1>");
    expect(prepared.html).not.toContain("<strong>");
  });

  it("keeps ordinary aozora-style bracket notation as literal characters when inputFormat is plain", () => {
    const prepared = prepareTextDocument({
      decodedText: "彼は倫敦《ロンドン》に住んでいた。［＃改ページ］",
      filename: "a.txt",
      options: DEFAULT_TEXT_OPTIONS,
    });
    expect(prepared.html).toContain("彼は倫敦《ロンドン》に住んでいた。［＃改ページ］");
    expect(prepared.html).not.toContain("<ruby>");
    expect(prepared.html).not.toContain("aozora-page-break");
  });
});

describe("prepareTextDocument — aozora branch", () => {
  const aozoraOptions = { ...DEFAULT_TEXT_OPTIONS, inputFormat: "aozora" as const };

  it("routes through the shared AST parser/renderer instead of paragraph-HTML escaping", () => {
    const prepared = prepareTextDocument({
      decodedText: "第一段落\n\n第二段落",
      filename: "novel.txt",
      options: aozoraOptions,
    });
    expect(prepared.html).toContain("<p>第一段落</p>");
    expect(prepared.html).toContain("<p>第二段落</p>");
  });

  it("never lets an embedded <script> become a live tag", () => {
    const prepared = prepareTextDocument({
      decodedText: "<script>alert(1)</script>",
      filename: "novel.txt",
      options: aozoraOptions,
    });
    expect(prepared.html).not.toContain("<script>alert(1)</script>");
    expect(prepared.html).toContain("&lt;script&gt;");
  });

  it("falls back to the filename/Untitled when no title is known", () => {
    const prepared = prepareTextDocument({
      decodedText: "本文",
      filename: "aozora-novel.txt",
      options: aozoraOptions,
    });
    expect(prepared.documentTitle).toBe("aozora-novel");
    expect(prepared.html).not.toContain("book-header");
  });

  it("prefers an explicit options.title/author for the header", () => {
    const prepared = prepareTextDocument({
      decodedText: "本文",
      filename: "novel.txt",
      options: { ...aozoraOptions, title: "指定された表題", author: "指定された著者" },
    });
    expect(prepared.documentTitle).toBe("指定された表題");
    expect(prepared.html).toContain('<header class="book-header">');
    expect(prepared.html).toContain("<h1>指定された表題</h1>");
    expect(prepared.html).toContain('<p class="author">指定された著者</p>');
  });

  it("ignores joinHardWrappedLines entirely (spec §10.3)", () => {
    const withTrue = prepareTextDocument({
      decodedText: "一行目\n二行目",
      filename: "novel.txt",
      options: { ...aozoraOptions, joinHardWrappedLines: true },
    });
    const withFalse = prepareTextDocument({
      decodedText: "一行目\n二行目",
      filename: "novel.txt",
      options: { ...aozoraOptions, joinHardWrappedLines: false },
    });
    expect(withTrue.html).toBe(withFalse.html);
    // Every source newline stays a real line break — never silently joined.
    expect(withTrue.html).toContain("一行目<br>二行目");
  });

  it("reports diagnostics shape even when nothing was flagged (PR1 parser)", () => {
    const prepared = prepareTextDocument({
      decodedText: "普通の文章。",
      filename: "novel.txt",
      options: aozoraOptions,
    });
    expect(prepared.diagnostics).toEqual({
      recognizedAnnotations: 0,
      unsupportedAnnotations: 0,
      malformedAnnotations: 0,
      truncatedDiagnostics: false,
    });
  });

  it("counts recognized aozora annotations instead of always reporting 0", () => {
    const prepared = prepareTextDocument({
      decodedText: "彼は倫敦《ロンドン》に住んでいた。\n\n［＃改ページ］\n\n次章［＃「次章」は中見出し］",
      filename: "novel.txt",
      options: aozoraOptions,
    });
    // 1 ruby + 1 pageBreak + 1 heading = 3.
    expect(prepared.diagnostics.recognizedAnnotations).toBe(3);
  });

  it("extracts XTC chapters from 大見出し when present (中見出し in the same document stays unmarked — A-1)", () => {
    const prepared = prepareTextDocument({
      decodedText: "序［＃「序」は大見出し］\n\n本文一。\n\n一［＃「一」は中見出し］\n\n本文二。\n\n結び［＃「結び」は大見出し］",
      filename: "novel.txt",
      options: aozoraOptions,
    });
    expect(prepared.chapterHeadingLevel).toBe(1);
    expect(prepared.chapters).toEqual([
      { name: "序", marker: "XTCCH0001" },
      { name: "結び", marker: "XTCCH0002" },
    ]);
    expect(prepared.html).toContain('<span class="xtc-chapter-marker" aria-hidden="true">XTCCH0001</span>');
    expect(prepared.html).toContain('<span class="xtc-chapter-marker" aria-hidden="true">XTCCH0002</span>');
    // "一" (中見出し) never gets a marker span, since this document's chapter
    // level resolved to 大 (only 2 marker SPANS total: 序/結び — matched via
    // the opening span tag specifically, since AOZORA_DOCUMENT_CSS's own
    // `.xtc-chapter-marker { ... }` rule also contains the class name once,
    // which a bare substring count would wrongly include).
    expect(prepared.html.match(/<span class="xtc-chapter-marker"/g)).toHaveLength(2);
  });

  it("falls back to 中見出し chapters when the document has no 大見出し at all (A-1)", () => {
    const prepared = prepareTextDocument({
      decodedText: "一［＃「一」は中見出し］\n\n本文一。\n\n二［＃「二」は中見出し］\n\n本文二。",
      filename: "novel.txt",
      options: aozoraOptions,
    });
    expect(prepared.chapterHeadingLevel).toBe(2);
    expect(prepared.chapters).toEqual([
      { name: "一", marker: "XTCCH0001" },
      { name: "二", marker: "XTCCH0002" },
    ]);
    expect(prepared.html).toContain('<span class="xtc-chapter-marker" aria-hidden="true">XTCCH0001</span>');
    expect(prepared.html).toContain('<span class="xtc-chapter-marker" aria-hidden="true">XTCCH0002</span>');
  });

  it("has no chapters and chapterHeadingLevel: null for a document with no heading at all", () => {
    const prepared = prepareTextDocument({
      decodedText: "見出しのない本文一。\n\n見出しのない本文二。",
      filename: "novel.txt",
      options: aozoraOptions,
    });
    expect(prepared.chapterHeadingLevel).toBeNull();
    expect(prepared.chapters).toEqual([]);
    // AOZORA_DOCUMENT_CSS (embedded for every aozora-format document) itself
    // names the .xtc-chapter-marker class, so a bare substring check would
    // false-positive here — the span element itself is what must be absent.
    expect(prepared.html).not.toContain("xtc-chapter-marker</span>");
    expect(prepared.html).not.toMatch(/<span class="xtc-chapter-marker"/);
  });

  it("has no chapters for a document with only 小見出し (小 is never a chapter source, and there is no fallback below it)", () => {
    const prepared = prepareTextDocument({
      decodedText: "節一［＃「節一」は小見出し］\n\n本文。",
      filename: "novel.txt",
      options: aozoraOptions,
    });
    expect(prepared.chapterHeadingLevel).toBeNull();
    expect(prepared.chapters).toEqual([]);
    expect(prepared.html).not.toMatch(/<span class="xtc-chapter-marker"/);
  });
});

describe("prepareTextDocument — plain inputFormat never produces chapters", () => {
  it("always returns chapters: [] and chapterHeadingLevel: null (no AST, no heading detection)", () => {
    const prepared = prepareTextDocument({
      decodedText: "見出し風の一行\n\n本文段落。",
      filename: "novel.txt",
      options: DEFAULT_TEXT_OPTIONS,
    });
    expect(prepared.chapters).toEqual([]);
    expect(prepared.chapterHeadingLevel).toBeNull();
    expect(prepared.html).not.toContain("xtc-chapter-marker");
  });
});
