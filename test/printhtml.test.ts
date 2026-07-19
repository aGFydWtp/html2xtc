import { describe, expect, it } from "vitest";
import { buildPrintHtml, printableText, sanitizeContent } from "../src/printhtml";
import type { ExtractedArticle } from "../src/extract";

const BASE = "https://example.com/dir/page";
const CONVERTED_AT = "2026-07-19 12:00 JST";

const article = (over: Partial<ExtractedArticle> = {}): ExtractedArticle => ({
  title: "記事タイトル",
  byline: "山田太郎",
  siteName: "サンプルサイト",
  lang: "ja",
  contentHtml: "<p>本文です。</p>",
  textContent: "本文です。",
  ...over,
});

describe("sanitizeContent", () => {
  it("removes scripts, embeds and interactive elements", () => {
    const out = sanitizeContent(
      '<p>keep</p><script>evil()</script><iframe src="https://x.example/"></iframe>' +
        '<form><input value="x"><button>go</button></form><video src="v.mp4"></video>',
      BASE,
    );
    expect(out).toContain("keep");
    for (const gone of ["<script", "<iframe", "<form", "<input", "<button", "<video"]) {
      expect(out).not.toContain(gone);
    }
  });

  it("strips on* handlers, inline styles and srcset/sizes", () => {
    const out = sanitizeContent(
      '<p onclick="x()" style="width:800px">t</p>' +
        '<img src="/a.png" srcset="/a2x.png 2x" sizes="100vw" alt="a">',
      BASE,
    );
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("style=");
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("sizes");
    expect(out).toContain('alt="a"'); // harmless attributes survive
  });

  it("resolves relative URLs against the base", () => {
    const out = sanitizeContent(
      '<img src="/img/a.png"><a href="../other">x</a>',
      BASE,
    );
    expect(out).toContain('src="https://example.com/img/a.png"');
    expect(out).toContain('href="https://example.com/other"');
  });

  it("drops javascript: and data: URLs entirely", () => {
    const out = sanitizeContent(
      '<a href="javascript:alert(1)">x</a><img src="data:text/html,hi">',
      BASE,
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:");
  });

  it("resolves namespace-prefixed URL attributes (xlink:href)", () => {
    const out = sanitizeContent(
      '<svg><image xlink:href="/img/pic.png"></image></svg>',
      BASE,
    );
    expect(out).toContain('xlink:href="https://example.com/img/pic.png"');
  });

  it("drops dangerous schemes behind namespace prefixes too", () => {
    const out = sanitizeContent(
      '<svg><a xlink:href="javascript:alert(1)">x</a>' +
        '<image xlink:href="data:text/html,hi"></image></svg>',
      BASE,
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:");
  });

  it("drops a leading heading that duplicates the title", () => {
    const out = sanitizeContent(
      "<h1>記事 タイトル</h1><p>本文</p>",
      BASE,
      "記事タイトル", // whitespace-insensitive match
    );
    expect(out).not.toContain("<h1>");
    expect(out).toContain("本文");
  });

  it("keeps a leading heading that differs from the title", () => {
    const out = sanitizeContent("<h1>別の見出し</h1><p>本文</p>", BASE, "記事タイトル");
    expect(out).toContain("別の見出し");
  });
});

describe("buildPrintHtml", () => {
  it("assembles a complete document with title, base and colophon", () => {
    const html = buildPrintHtml(article(), BASE, CONVERTED_AT);
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('lang="ja"');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`<base href="${BASE}">`);
    expect(html).toContain("<title>記事タイトル</title>");
    expect(html).toContain("<h1>記事タイトル</h1>");
    expect(html).toContain("本文です。");
    expect(html).toContain('id="xtc-colophon"');
    expect(html).toContain("タイトル: 記事タイトル");
    expect(html).toContain("サイト名: サンプルサイト");
    expect(html).toContain("著者: 山田太郎");
    expect(html).toContain(`URL: ${BASE}`);
    expect(html).toContain(`変換日時: ${CONVERTED_AT}`);
    expect(html).toContain("個人的利用のために作成。再配布禁止。");
    expect(html).toContain("break-before:page");
  });

  it("falls back to (無題) and the hostname when metadata is missing", () => {
    const html = buildPrintHtml(
      article({ title: undefined, byline: undefined, siteName: undefined }),
      BASE,
      CONVERTED_AT,
    );
    expect(html).toContain("<title>(無題)</title>");
    expect(html).toContain("サイト名: example.com");
    expect(html).not.toContain("著者:");
  });

  it("neutralizes markup in the title (linkedom does not escape <title>)", () => {
    const html = buildPrintHtml(
      article({ title: 'x</title><script>alert(1)</script>' }),
      BASE,
      CONVERTED_AT,
    );
    expect(html).not.toContain("</title><script>");
    // The h1 goes through textContent and is entity-escaped instead.
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes page-derived text in body elements", () => {
    const html = buildPrintHtml(
      article({ byline: '"><img src=x onerror=alert(1)>' }),
      BASE,
      CONVERTED_AT,
    );
    expect(html).not.toContain("<img src=x");
  });

  it("carries no font reference at all (fonts travel via addStyleTag)", () => {
    // The inlined font CSS is injected at render time via addStyleTag; a
    // font <link>/<style> here would either be dead weight or a duplicate
    // fetch racing the injected faces.
    const html = buildPrintHtml(article(), BASE, CONVERTED_AT);
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("@font-face");
    expect(html).not.toContain("<link");
  });
});

describe("printableText", () => {
  it("covers title, metadata, colophon labels and the body text", () => {
    const text = printableText(article(), BASE, CONVERTED_AT);
    for (const piece of [
      "記事タイトル",
      "サンプルサイト",
      "山田太郎",
      "example.com",
      BASE,
      CONVERTED_AT,
      "変換日時",
      "個人的利用のために作成。再配布禁止。",
      "Created for personal use. Redistribution prohibited.",
      "本文です。",
    ]) {
      expect(text).toContain(piece);
    }
  });

  it("uses the (無題) fallback so its glyphs are always subsetted", () => {
    const text = printableText(article({ title: undefined }), BASE, CONVERTED_AT);
    expect(text).toContain("(無題)");
  });
});
