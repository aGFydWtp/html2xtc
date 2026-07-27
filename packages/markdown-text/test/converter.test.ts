// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { XTC_CHAPTER_MARKER_CLASS } from "../../aozora-text/src/chapters";
import { createMarkdownConverter } from "../src/converter";
import {
  MARKDOWN_IT_OPTIONS,
  MARKDOWN_MAX_NESTING,
  MAX_MARKDOWN_TOKENS,
  MarkdownComplexityLimitError,
} from "../src/types";
import type { MarkdownConverter } from "../src/types";

/** The exact wiring src/text-prepare.ts is expected to use (spec §6.3's
 * concept example) — every test below goes through this, never a
 * hand-built token array, so these tests exercise the real markdown-it
 * 14.3.0 output this package's renderer/chapters/plain-text code must
 * handle. */
function makeConverter(): MarkdownConverter {
  return createMarkdownConverter(() => new MarkdownIt(MARKDOWN_IT_OPTIONS));
}

describe("MARKDOWN_IT_OPTIONS", () => {
  it("matches spec §6.2 exactly", () => {
    expect(MARKDOWN_IT_OPTIONS).toEqual({
      html: false,
      linkify: false,
      typographer: false,
      breaks: false,
      xhtmlOut: false,
      maxNesting: 50,
    });
  });
});

describe("createMarkdownConverter — syntax coverage (spec §22.2)", () => {
  const converter = makeConverter();

  it("renders ATX headings h1-h6", () => {
    const { contentHtml } = converter.parse("# a\n## b\n### c\n#### d\n##### e\n###### f\n");
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(contentHtml).toContain(`<${tag}>`);
      expect(contentHtml).toContain(`</${tag}>`);
    }
  });

  it("renders Setext h1/h2", () => {
    const { contentHtml } = converter.parse("Title\n=====\n\nSub\n-----\n");
    expect(contentHtml).toContain("<h1>");
    expect(contentHtml).toContain("<h2>");
  });

  it("renders paragraphs", () => {
    const { contentHtml } = converter.parse("段落一\n\n段落二\n");
    expect(contentHtml).toContain("<p>段落一</p>");
    expect(contentHtml).toContain("<p>段落二</p>");
  });

  it("renders bold, italic, and strikethrough", () => {
    const { contentHtml } = converter.parse("**太字** *斜体* ~~消し線~~\n");
    expect(contentHtml).toContain("<strong>太字</strong>");
    expect(contentHtml).toContain("<em>斜体</em>");
    expect(contentHtml).toContain("<s>消し線</s>");
  });

  it("renders ordered, unordered, and nested lists", () => {
    const { contentHtml } = converter.parse("- a\n- b\n  1. nested\n  2. list\n");
    expect(contentHtml).toContain("<ul>");
    expect(contentHtml).toContain("<ol>");
    expect(contentHtml).toContain("<li>");
  });

  it("renders blockquotes", () => {
    const { contentHtml } = converter.parse("> 引用\n");
    expect(contentHtml).toContain("<blockquote>");
    expect(contentHtml).toContain("引用");
  });

  it("renders inline code, fenced code, and indented code", () => {
    const { contentHtml } = converter.parse(
      "`inline` code\n\n```js\nconst a = 1;\n```\n\n    indented code\n",
    );
    expect(contentHtml).toContain("<code>inline</code>");
    expect(contentHtml).toContain("<pre><code>const a = 1;");
    expect(contentHtml).toContain("<pre><code>indented code");
  });

  it("renders a horizontal rule", () => {
    expect(converter.parse("---\n").contentHtml).toContain("<hr>");
  });

  it("renders a table", () => {
    const { contentHtml } = converter.parse("| a | b |\n|---|---|\n| 1 | 2 |\n");
    for (const tag of ["table", "thead", "tbody", "tr", "th", "td"]) {
      expect(contentHtml).toContain(`<${tag}>`);
    }
  });

  it("renders a hard break as <br>, keeping the two trailing spaces significant", () => {
    const { contentHtml } = converter.parse("line one  \nline two\n");
    expect(contentHtml).toContain("<br>");
  });

  it("renders Japanese text and emoji/surrogate pairs intact", () => {
    const { contentHtml, plainText } = converter.parse("こんにちは 😀 世界\n");
    expect(contentHtml).toContain("こんにちは 😀 世界");
    expect(plainText).toContain("😀");
  });

  it("unifies CRLF to LF-equivalent rendering (no literal \\r leaks through)", () => {
    const { contentHtml } = converter.parse("a\r\n\r\nb\r\n");
    expect(contentHtml).not.toContain("\r");
  });
});

describe("createMarkdownConverter — links and images (spec §7.1/§7.2)", () => {
  const converter = makeConverter();

  it("renders a Markdown link as label-only text, never href", () => {
    const { contentHtml } = converter.parse("[Cloudflare](https://www.cloudflare.com/)\n");
    expect(contentHtml).toContain('<span class="md-link">Cloudflare</span>');
    expect(contentHtml).not.toContain("href");
    expect(contentHtml).not.toContain("cloudflare.com");
  });

  it("renders a CommonMark autolink as the literal URL text, never href", () => {
    const { contentHtml } = converter.parse("<https://example.com/>\n");
    expect(contentHtml).toContain('<span class="md-link">https://example.com/</span>');
    expect(contentHtml).not.toContain("href");
  });

  it("renders an image with alt text as a bracketed placeholder, never src/img", () => {
    const { contentHtml } = converter.parse("![構成図](./architecture.png)\n");
    expect(contentHtml).toContain('<span class="md-image-placeholder">［画像: 構成図］</span>');
    expect(contentHtml).not.toContain("<img");
    expect(contentHtml).not.toContain("src=");
    expect(contentHtml).not.toContain("architecture.png");
  });

  it("renders an image with empty alt as the bracket-only placeholder", () => {
    const { contentHtml } = converter.parse("![](./no-alt.png)\n");
    expect(contentHtml).toContain('<span class="md-image-placeholder">［画像］</span>');
    expect(contentHtml).not.toContain("no-alt.png");
  });
});

describe("createMarkdownConverter — security allowlist (spec §22.3)", () => {
  const converter = makeConverter();
  const maliciousSource = [
    "<script>alert(1)</script>",
    "<style>body{display:none}</style>",
    '<iframe src="https://example.com"></iframe>',
    "<img src=x onerror=alert(1)>",
    "[危険](javascript:alert(1))",
    "![画像](https://example.com/a.png)",
  ].join("\n\n");

  it("contains no raw script/style/iframe/img tag", () => {
    const { contentHtml } = converter.parse(maliciousSource);
    expect(contentHtml).not.toMatch(/<script/i);
    expect(contentHtml).not.toMatch(/<style/i);
    expect(contentHtml).not.toMatch(/<iframe/i);
    expect(contentHtml).not.toMatch(/<img/i);
  });

  it("contains no live href/src/onerror attribute or javascript: scheme", () => {
    // The malicious source's raw text (e.g. `src=x`, `href=...`) is expected
    // to survive as ESCAPED visible characters (`&lt;img src=x ...&gt;`) —
    // that is safe, inert text, not a real attribute. What must never occur
    // is one of these appearing as an actual, unescaped HTML attribute
    // (`src="..."`, `href="..."`, `onerror="..."`) on a real tag.
    const { contentHtml } = converter.parse(maliciousSource);
    expect(contentHtml).not.toMatch(/<[a-z][^&]*\shref=/i);
    expect(contentHtml).not.toMatch(/<[a-z][^&]*\ssrc=/i);
    expect(contentHtml).not.toMatch(/<[a-z][^&]*\sonerror=/i);
    // "javascript:" itself is fine to appear as escaped visible text (as it
    // does here, inside the link label), but must never sit inside a real
    // attribute value — there is no attribute value anywhere in this
    // renderer's output that ever copies user input, so a live href/src
    // check above already covers this; this direct check pins that no
    // `href="javascript:...")` variant slips through some other path.
    expect(contentHtml).not.toMatch(/="[^"]*javascript:/i);
  });

  it("shows the raw HTML/markdown-link source as safely escaped visible text", () => {
    const { contentHtml } = converter.parse(maliciousSource);
    expect(contentHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(contentHtml).toContain("&lt;style&gt;body{display:none}&lt;/style&gt;");
    expect(contentHtml).toContain("危険");
  });

  it("emits only the allowlisted tag set across a broad document", () => {
    const source = [
      "# H1",
      "## H2",
      "para **bold** *em* ~~s~~ `code`",
      "- a",
      "1. b",
      "> quote",
      "```\nfence\n```",
      "---",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "[link](https://x.example/)",
      "![alt](https://x.example/a.png)",
      "line  ",
      "break",
    ].join("\n\n");
    const { contentHtml } = converter.parse(source);
    const allowedTags = new Set([
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "em",
      "strong",
      "s",
      "ul",
      "ol",
      "li",
      "blockquote",
      "code",
      "pre",
      "hr",
      "br",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "span",
    ]);
    const seenTags = new Set<string>();
    for (const match of contentHtml.matchAll(/<\/?([a-zA-Z0-9]+)/g)) {
      seenTags.add(match[1].toLowerCase());
    }
    for (const tag of seenTags) {
      expect(allowedTags.has(tag)).toBe(true);
    }
  });

  it("emits only the allowlisted attribute set (start, class, aria-hidden)", () => {
    const source = "5. five\n6. six\n\n# heading for a marker\n";
    const { contentHtml } = converter.parse(source);
    const allowedAttrNames = new Set(["start", "class", "aria-hidden"]);
    for (const match of contentHtml.matchAll(/<[a-zA-Z0-9]+((?:\s+[a-zA-Z0-9-]+="[^"]*")*)\s*>/g)) {
      const attrsPart = match[1] ?? "";
      for (const attrMatch of attrsPart.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) {
        expect(allowedAttrNames.has(attrMatch[1])).toBe(true);
      }
    }
  });

  it("renders a safe ol[start] as a validated non-negative integer only", () => {
    const { contentHtml } = converter.parse("5. five\n6. six\n");
    expect(contentHtml).toContain('<ol start="5">');
  });

  it("only ever emits the fixed class names md-link/md-image-placeholder/xtc-chapter-marker", () => {
    const source = "# H\n\n[l](https://x.example/)\n\n![a](https://x.example/a.png)\n";
    const { contentHtml } = converter.parse(source);
    for (const match of contentHtml.matchAll(/class="([^"]*)"/g)) {
      expect(["md-link", "md-image-placeholder", XTC_CHAPTER_MARKER_CLASS]).toContain(match[1]);
    }
  });
});

describe("createMarkdownConverter — title (spec §22.4 subset owned by this package)", () => {
  const converter = makeConverter();

  it("exposes the first non-empty H1's plain text as firstH1", () => {
    const { firstH1 } = converter.parse("# はじめに\n\n本文\n\n# 二つ目\n");
    expect(firstH1).toBe("はじめに");
  });

  it("strips decoration from firstH1", () => {
    const { firstH1 } = converter.parse("# **重要な** 設計 `v2`\n");
    expect(firstH1).toBe("重要な 設計 v2");
  });

  it("leaves firstH1 undefined when there is no non-empty H1", () => {
    expect(converter.parse("## only h2\n").firstH1).toBeUndefined();
    expect(converter.parse("#\n\nbody\n").firstH1).toBeUndefined();
  });
});

describe("createMarkdownConverter — chapters (spec §22.5)", () => {
  const converter = makeConverter();

  it("uses every non-empty H1 as chapters, in document order, when H1s exist", () => {
    const { chapters, chapterHeadingLevel } = converter.parse(
      "# はじめに\n\nbody\n\n## ignored h2\n\n# 設計\n\n# 実装\n",
    );
    expect(chapterHeadingLevel).toBe(1);
    expect(chapters).toEqual([
      { name: "はじめに", marker: "XTCCH0001" },
      { name: "設計", marker: "XTCCH0002" },
      { name: "実装", marker: "XTCCH0003" },
    ]);
  });

  it("falls back to H2 when there is no H1", () => {
    const { chapters, chapterHeadingLevel } = converter.parse("## 一章\n\n## 二章\n");
    expect(chapterHeadingLevel).toBe(2);
    expect(chapters).toEqual([
      { name: "一章", marker: "XTCCH0001" },
      { name: "二章", marker: "XTCCH0002" },
    ]);
  });

  it("produces no chapters when only H3+ headings exist", () => {
    const { chapters, chapterHeadingLevel } = converter.parse("### only h3\n");
    expect(chapterHeadingLevel).toBeNull();
    expect(chapters).toEqual([]);
  });

  it("excludes an empty heading from the chapter list", () => {
    const { chapters } = converter.parse("# \n\n# 実質\n");
    expect(chapters).toEqual([{ name: "実質", marker: "XTCCH0001" }]);
  });

  it("strips decoration from a chapter name", () => {
    const { chapters } = converter.parse("# **重要な** 設計 `v2`\n");
    expect(chapters).toEqual([{ name: "重要な 設計 v2", marker: "XTCCH0001" }]);
  });

  it("embeds each marker immediately before its heading, matching chapters in count and order", () => {
    const { contentHtml, chapters } = converter.parse("# 一\n\n# 二\n\n# 三\n");
    expect(chapters.length).toBe(3);
    // The renderer always concatenates the marker span directly against the
    // heading's own opening tag (renderer.ts's `${markerHtml}<${tag}>`), so
    // this exact adjacency is the precise contract to check — not just "the
    // marker appears somewhere before the heading".
    for (const chapter of chapters) {
      expect(contentHtml).toContain(`<span class="xtc-chapter-marker" aria-hidden="true">${chapter.marker}</span><h1>`);
    }
    // Markers appear in the same order as `chapters`, and each exactly once.
    let searchFrom = 0;
    for (const chapter of chapters) {
      const index = contentHtml.indexOf(chapter.marker, searchFrom);
      expect(index).toBeGreaterThanOrEqual(searchFrom);
      expect(contentHtml.split(chapter.marker).length - 1).toBe(1);
      searchFrom = index + chapter.marker.length;
    }
  });

  it("finds headings nested inside a list or blockquote too", () => {
    const { chapters } = converter.parse("> # quoted heading\n\n- # list heading\n");
    expect(chapters).toEqual([
      { name: "quoted heading", marker: "XTCCH0001" },
      { name: "list heading", marker: "XTCCH0002" },
    ]);
  });
});

describe("createMarkdownConverter — plain text extraction (spec §22.7)", () => {
  const converter = makeConverter();

  it("excludes syntax markers", () => {
    const { plainText } = converter.parse("# H\n\n**b** *i* `c`\n");
    expect(plainText).not.toContain("#");
    expect(plainText).not.toContain("*");
    expect(plainText).not.toContain("`");
  });

  it("excludes a link's URL but includes its label", () => {
    const { plainText } = converter.parse("[表示](https://example.com/secret-path)\n");
    expect(plainText).toContain("表示");
    expect(plainText).not.toContain("example.com");
  });

  it("includes an autolink's own visible URL text", () => {
    const { plainText } = converter.parse("<https://example.com/>\n");
    expect(plainText).toContain("https://example.com/");
  });

  it("includes image alt text", () => {
    const { plainText } = converter.parse("![構成図](./a.png)\n");
    expect(plainText).toContain("構成図");
    expect(plainText).not.toContain("a.png");
  });

  it("includes code block content", () => {
    const { plainText } = converter.parse("```\nconst a = 1;\n```\n");
    expect(plainText).toContain("const a = 1;");
  });

  it("never includes an embedded chapter-marker string", () => {
    const { plainText, chapters } = converter.parse("# 章一\n\nbody\n");
    expect(chapters.length).toBe(1);
    expect(plainText).not.toContain(chapters[0].marker);
  });

  it("treats a whitespace-only document as empty", () => {
    const { plainText } = converter.parse("   \n\t\n   \n");
    expect(plainText.trim()).toBe("");
  });
});

describe("createMarkdownConverter — normalization independence (spec §22.6)", () => {
  const converter = makeConverter();

  it("preserves fenced code block indentation", () => {
    const { contentHtml } = converter.parse("```\n  indented line\n    more indented\n```\n");
    expect(contentHtml).toContain("  indented line\n    more indented");
  });

  it("preserves indented-code-block leading 4 spaces as code content", () => {
    const { contentHtml } = converter.parse("    four space indent\n");
    expect(contentHtml).toContain("four space indent");
    expect(contentHtml).toContain("<pre><code>");
  });

  it("keeps a hard break's <br> regardless of trailing-space count beyond 2", () => {
    const { contentHtml } = converter.parse("line one   \nline two\n");
    expect(contentHtml).toContain("<br>");
  });
});

describe("createMarkdownConverter — complexity limits (spec §14/§21)", () => {
  it("throws MarkdownComplexityLimitError when inline nesting exceeds the limit", () => {
    const converter = makeConverter();
    let nested = "text";
    for (let i = 0; i < 300; i++) {
      nested = `*${nested}*`;
    }
    expect(() => converter.parse(`${nested}\n`)).toThrow(MarkdownComplexityLimitError);
  });

  it("does not throw for ordinary, shallow documents", () => {
    const converter = makeConverter();
    expect(() => converter.parse("# ok\n\nsome *emphasis* and **bold**.\n")).not.toThrow();
  });

  it("MarkdownComplexityLimitError carries a fixed, content-free message", () => {
    const error = new MarkdownComplexityLimitError();
    expect(error.message).toBe("Markdown document is too complex to convert");
  });

  it("exposes constants matching spec §14", () => {
    expect(MAX_MARKDOWN_TOKENS).toBe(500_000);
    expect(MARKDOWN_MAX_NESTING).toBe(50);
  });

  it("reports tokenCount for an ordinary document", () => {
    const converter = makeConverter();
    const { tokenCount } = converter.parse("# H\n\npara\n");
    expect(tokenCount).toBeGreaterThan(0);
  });
});

describe("createMarkdownConverter — reuses the injected instance across parses", () => {
  it("does not require a new factory call per parse", () => {
    let calls = 0;
    const converter = createMarkdownConverter(() => {
      calls++;
      return new MarkdownIt(MARKDOWN_IT_OPTIONS);
    });
    converter.parse("a\n");
    converter.parse("b\n");
    converter.parse("c\n");
    expect(calls).toBe(1);
  });
});
