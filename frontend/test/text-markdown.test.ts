// SPDX-License-Identifier: AGPL-3.0-or-later
// フロントエンド本文プレビュー用Markdown変換のテスト（Markdown対応仕様書 §17.5、
// §22.3「入力: <script>...」の安全性検証を本文プレビュー経路でも確認する）。
// 実際の許可リストHTML生成・章抽出・複雑度判定そのものは共有パッケージ
// @html2xtc/markdown-text 側（packages/markdown-text/test/）でテスト済みのため、
// ここではフロントエンドの薄い配線（fail-softなラップ）だけを検証する。
import { describe, expect, it } from "vitest";
import { parseMarkdownPreview } from "../src/lib/text-markdown";

describe("parseMarkdownPreview (Markdown対応仕様書 §17.5)", () => {
  it("renders headings/lists/links/images into safe, allowlisted HTML", () => {
    const source = [
      "# Heading",
      "",
      "- item one",
      "- item two",
      "",
      "[a link](https://example.com/)",
      "",
      "![alt text](https://example.com/a.png)",
    ].join("\n");
    const result = parseMarkdownPreview(source);
    expect(result).not.toBeNull();
    const html = result?.contentHtml ?? "";
    expect(html).toContain("<h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain('class="md-link"');
    expect(html).toContain('class="md-image-placeholder"');
    expect(html).not.toContain("href=");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });

  it("never lets raw HTML/script/style/iframe/img through as live tags — only as escaped literal text (§22.3)", () => {
    // html:false (MARKDOWN_IT_OPTIONS) means none of these ever become real
    // tags; markdown-it renders each line as an ordinary paragraph of
    // escaped text instead. The escaped substrings (e.g. "onerror=") are
    // therefore expected to remain visible as harmless text content — what
    // matters is that no unescaped "<script", "<img", "<iframe", "<style"
    // ever appears as an actual tag.
    const source = [
      "<script>alert(1)</script>",
      "",
      "<style>body{display:none}</style>",
      "",
      '<iframe src="https://example.com"></iframe>',
      "",
      "<img src=x onerror=alert(1)>",
    ].join("\n");
    const result = parseMarkdownPreview(source);
    expect(result).not.toBeNull();
    const html = result?.contentHtml ?? "";
    expect(html).not.toMatch(/<script[ >]/);
    expect(html).not.toMatch(/<style[ >]/);
    expect(html).not.toMatch(/<iframe/);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("never emits an href for a Markdown link — only the visible label (§7.1)", () => {
    const result = parseMarkdownPreview("[Cloudflare](https://www.cloudflare.com/)");
    expect(result).not.toBeNull();
    const html = result?.contentHtml ?? "";
    expect(html).not.toContain("href=");
    expect(html).not.toContain("cloudflare.com");
    expect(html).toContain('<span class="md-link">Cloudflare</span>');
  });

  it("fails soft (returns null) instead of throwing when the input exceeds the complexity limit", () => {
    // 300 levels of nested emphasis (same construction as
    // packages/markdown-text/test/converter.test.ts's own complexity-limit
    // test) — a cheap way to trigger MarkdownComplexityLimitError
    // (MARKDOWN_MAX_NESTING=50) without a huge document.
    let nested = "text";
    for (let i = 0; i < 300; i++) {
      nested = `*${nested}*`;
    }
    expect(() => parseMarkdownPreview(nested)).not.toThrow();
    expect(parseMarkdownPreview(nested)).toBeNull();
  });
});
