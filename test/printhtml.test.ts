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

  it("promotes data-src onto a src-less lazy image and resolves it", () => {
    const out = sanitizeContent(
      '<img data-src="/lazy/a.jpg" alt="a">',
      BASE,
    );
    expect(out).toContain('src="https://example.com/lazy/a.jpg"');
    expect(out).not.toContain("data-src");
  });

  it("replaces a data: URI placeholder src with the deferred URL", () => {
    const out = sanitizeContent(
      '<img src="data:image/gif;base64,R0lGOD" data-lazy-src="/lazy/b.png">',
      BASE,
    );
    expect(out).toContain('src="https://example.com/lazy/b.png"');
    expect(out).not.toContain("data:image/gif");
  });

  it("replaces a spacer-file placeholder src via data-original", () => {
    const out = sanitizeContent(
      '<img src="/img/1x1.gif" data-original="/lazy/c.jpg">',
      BASE,
    );
    expect(out).toContain('src="https://example.com/lazy/c.jpg"');
    expect(out).not.toContain("1x1.gif");
  });

  it("does not mistake a real file name containing a placeholder word", () => {
    // "pixel" appears only as part of a larger name — a substring heuristic
    // would wrongly swap this real image for the data-src value.
    const out = sanitizeContent(
      '<img src="/img/pixel-art-collection.png" data-src="/lazy/other.jpg">',
      BASE,
    );
    expect(out).toContain('src="https://example.com/img/pixel-art-collection.png"');
    expect(out).not.toContain("other.jpg");
  });

  it("picks a candidate covering 528px when only a srcset exists", () => {
    const out = sanitizeContent(
      '<img data-srcset="/a-300.jpg 300w, /a-600.jpg 600w, /a-1200.jpg 1200w">',
      BASE,
    );
    // Smallest width that still covers the X3's 528px output.
    expect(out).toContain('src="https://example.com/a-600.jpg"');
    expect(out).not.toContain("srcset");
  });

  it("falls back to the largest srcset candidate below the target", () => {
    const out = sanitizeContent(
      '<img srcset="/a-200.jpg 200w, /a-400.jpg 400w">',
      BASE,
    );
    expect(out).toContain('src="https://example.com/a-400.jpg"');
  });

  it("prefers the lowest density for density-descriptor srcsets", () => {
    const out = sanitizeContent(
      '<img data-srcset="/a-2x.jpg 2x, /a-1x.jpg 1x">',
      BASE,
    );
    expect(out).toContain('src="https://example.com/a-1x.jpg"');
  });

  it('removes loading="lazy" so the static render fetches every image', () => {
    const out = sanitizeContent(
      '<img src="/a.png" loading="lazy"><img src="/b.png" loading="eager">',
      BASE,
    );
    expect(out).not.toContain('loading="lazy"');
    expect(out).toContain('loading="eager"'); // only the lazy hint is dropped
  });

  it("leaves a normal image's real src alone despite lazy attributes", () => {
    const out = sanitizeContent(
      '<img src="/real.jpg" data-src="/other.jpg">',
      BASE,
    );
    expect(out).toContain('src="https://example.com/real.jpg"');
    expect(out).not.toContain("other.jpg");
  });

  it("drops a promoted deferred URL with a dangerous scheme", () => {
    const out = sanitizeContent(
      '<img data-src="javascript:alert(1)">',
      BASE,
    );
    expect(out).not.toContain("javascript:");
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

  it("embeds documentCss as a head <style>", () => {
    const html = buildPrintHtml(
      article(),
      BASE,
      CONVERTED_AT,
      ".jisage_2 { margin-inline-start: 2em !important; }",
    );
    expect(html).toContain("<style>");
    expect(html).toContain(".jisage_2 { margin-inline-start: 2em !important; }");
  });

  it("neutralizes markup in documentCss (linkedom does not escape <style>)", () => {
    // Defense in depth: the only current caller passes a static constant,
    // but a "</style>" sequence must never escape into the head — the
    // rendering browser executes scripts (quickAction("pdf")).
    const html = buildPrintHtml(
      article(),
      BASE,
      CONVERTED_AT,
      'body { color: red } </style><script>alert(1)</script><style>',
    );
    expect(html).not.toContain("</style><script>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)</script>");
    // The sane part of the CSS survives.
    expect(html).toContain("body { color: red }");
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

  // 青空文庫PDFタイムアウト時の4分割フォールバック仕様 §15: PrintDocumentOptions
  // (back-compat 5th argument). Every field defaults to true, so every call
  // site above (no 5th argument) keeps producing an unchanged document.
  it("omits the header when includeDocumentHeader is false, but keeps <title>", () => {
    const html = buildPrintHtml(article(), BASE, CONVERTED_AT, undefined, {
      includeDocumentHeader: false,
    });
    expect(html).not.toContain("<h1>");
    // <title> is unaffected — it is not part of the "header" toggle.
    expect(html).toContain("<title>記事タイトル</title>");
    // The colophon (default true) is unaffected by this option.
    expect(html).toContain('id="xtc-colophon"');
  });

  it("omits the colophon when includeColophon is false", () => {
    const html = buildPrintHtml(article(), BASE, CONVERTED_AT, undefined, {
      includeColophon: false,
    });
    expect(html).not.toContain('id="xtc-colophon"');
    expect(html).not.toContain("break-before:page");
    // The header (default true) is unaffected by this option.
    expect(html).toContain("<h1>記事タイトル</h1>");
  });

  it("can omit both header and colophon, leaving only the content", () => {
    const html = buildPrintHtml(article(), BASE, CONVERTED_AT, undefined, {
      includeDocumentHeader: false,
      includeColophon: false,
    });
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain('id="xtc-colophon"');
    expect(html).toContain("本文です。");
  });

  it("defaults every option to true when options is omitted or partially specified", () => {
    const withoutOptions = buildPrintHtml(article(), BASE, CONVERTED_AT);
    const withEmptyOptions = buildPrintHtml(article(), BASE, CONVERTED_AT, undefined, {});
    expect(withEmptyOptions).toBe(withoutOptions);
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
