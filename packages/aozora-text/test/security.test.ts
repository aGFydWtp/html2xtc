// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { parseAozoraDocument } from "../src/parse-document";
import { renderBibliographyToHtml, renderDocumentToHtml } from "../src/render-html";
import type { AozoraDocument } from "../src/types";

/**
 * Spec §18.5's security fixtures. These construct the AST directly (the
 * PR1 parser doesn't recognize annotations yet), asserting the invariant
 * PR2's real parser must also uphold: whatever ends up in a `text` /
 * `ruby.reading` / `gaiji.description` / `rawAnnotation.text` field, the
 * renderer must never let it become a live tag or attribute.
 */

const SCRIPT_PAYLOAD = "<script>alert(1)</script>";
const IMG_ONERROR_PAYLOAD = '<img src=x onerror=alert(1)>';
const STYLE_BREAKOUT_PAYLOAD = '"><style>body{display:none}</style>';

function docWithText(value: string): AozoraDocument {
  return {
    blocks: [{ type: "paragraph", children: [{ type: "text", value }] }],
    bibliography: [],
    diagnostics: [],
  };
}

describe("security: <script> never becomes a live tag", () => {
  it("in a text node", () => {
    const html = renderDocumentToHtml(docWithText(SCRIPT_PAYLOAD));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("in a rawAnnotation node", () => {
    const html = renderDocumentToHtml({
      blocks: [
        {
          type: "paragraph",
          children: [{ type: "rawAnnotation", text: SCRIPT_PAYLOAD }],
        },
      ],
      bibliography: [],
      diagnostics: [],
    });
    expect(html).not.toContain("<script>");
  });

  it("in a bibliography block", () => {
    const html = renderBibliographyToHtml([
      { type: "paragraph", children: [{ type: "text", value: SCRIPT_PAYLOAD }] },
    ]);
    expect(html).not.toContain("<script>");
  });
});

describe("security: <img onerror> never becomes a live attribute", () => {
  it("inside a ruby base", () => {
    const html = renderDocumentToHtml({
      blocks: [
        {
          type: "paragraph",
          children: [
            {
              type: "ruby",
              base: [{ type: "text", value: IMG_ONERROR_PAYLOAD }],
              reading: "よみ",
            },
          ],
        },
      ],
      bibliography: [],
      diagnostics: [],
    });
    expect(html).not.toContain("<img");
    // The payload survives only as inert escaped text — never as a real
    // onerror="..." attribute (which would require an unescaped `<img `).
    expect(html).not.toMatch(/<img\b/);
    expect(html).toContain("&lt;img");
  });

  it("inside a gaiji description (title attribute)", () => {
    const html = renderDocumentToHtml({
      blocks: [
        {
          type: "paragraph",
          children: [{ type: "gaiji", description: IMG_ONERROR_PAYLOAD }],
        },
      ],
      bibliography: [],
      diagnostics: [],
    });
    expect(html).not.toMatch(/<img\b/);
    // The quote inside the payload must be escaped so it cannot close the
    // title="..." attribute early.
    expect(html).toContain("title=\"&lt;img src=x onerror=alert(1)&gt;\"");
  });
});

describe("security: no style attribute/tag escapes the allowlist", () => {
  it("a `\">` breakout attempt in text stays inert text", () => {
    const html = renderDocumentToHtml(docWithText(STYLE_BREAKOUT_PAYLOAD));
    expect(html).not.toContain("<style>");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain("&quot;&gt;&lt;style&gt;");
  });

  it("the same payload in a gaiji title attribute cannot break out", () => {
    const html = renderDocumentToHtml({
      blocks: [
        {
          type: "paragraph",
          children: [{ type: "gaiji", description: STYLE_BREAKOUT_PAYLOAD }],
        },
      ],
      bibliography: [],
      diagnostics: [],
    });
    expect(html).not.toContain("<style>");
    expect(html).not.toMatch(/\sstyle=/);
    // The quote that would close title="" early must be escaped.
    expect(html).toContain("&quot;&gt;&lt;style&gt;");
  });
});

describe("security: only the fixed allowlist tags/attributes ever appear", () => {
  const ALLOWED_TAGS = new Set(["p", "br", "h2", "h3", "h4", "ruby", "rb", "rt", "rp", "span", "em", "strong", "div"]);
  const ALLOWED_ATTRS = new Set(["class", "aria-hidden", "title"]);

  function collectTagsAndAttrs(html: string): { tags: Set<string>; attrs: Set<string> } {
    const tags = new Set<string>();
    const attrs = new Set<string>();
    const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*\/?>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(html)) !== null) {
      tags.add(match[1].toLowerCase());
      const attrRe = /([^\s=/>]+)(?:="[^"]*")?/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRe.exec(match[2])) !== null) {
        attrs.add(attrMatch[1].toLowerCase());
      }
    }
    return { tags, attrs };
  }

  it("holds for a document built from every malicious fixture at once", () => {
    const html =
      renderDocumentToHtml({
        blocks: [
          { type: "paragraph", children: [{ type: "text", value: SCRIPT_PAYLOAD }] },
          {
            type: "paragraph",
            children: [
              {
                type: "ruby",
                base: [{ type: "text", value: IMG_ONERROR_PAYLOAD }],
                reading: STYLE_BREAKOUT_PAYLOAD,
              },
            ],
          },
          { type: "rawAnnotation", text: STYLE_BREAKOUT_PAYLOAD },
          {
            type: "paragraph",
            children: [{ type: "gaiji", description: IMG_ONERROR_PAYLOAD + STYLE_BREAKOUT_PAYLOAD }],
          },
        ],
        bibliography: [
          { type: "paragraph", children: [{ type: "text", value: SCRIPT_PAYLOAD }] },
        ],
        diagnostics: [],
      }) + renderBibliographyToHtml([{ type: "paragraph", children: [{ type: "text", value: SCRIPT_PAYLOAD }] }]);

    const { tags, attrs } = collectTagsAndAttrs(html);
    for (const tag of tags) {
      expect(ALLOWED_TAGS.has(tag)).toBe(true);
    }
    for (const attr of attrs) {
      expect(ALLOWED_ATTRS.has(attr)).toBe(true);
    }
  });
});

/**
 * End-to-end variant of spec §18.5's 3 example lines: fed through the real
 * lexer/parser (parseAozoraDocument), not a hand-built AST — this is the
 * actual attack surface (untrusted TXT upload text), and it must produce
 * the exact same allowlist-only guarantees as the AST-level tests above.
 */
describe("security: spec §18.5's exact input fed through the real parser end-to-end", () => {
  const ALLOWED_TAGS = new Set(["p", "br", "h2", "h3", "h4", "ruby", "rb", "rt", "rp", "span", "em", "strong", "div"]);
  const ALLOWED_ATTRS = new Set(["class", "aria-hidden", "title"]);

  function collectTagsAndAttrs(html: string): { tags: Set<string>; attrs: Set<string> } {
    const tags = new Set<string>();
    const attrs = new Set<string>();
    const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*\/?>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(html)) !== null) {
      tags.add(match[1].toLowerCase());
      const attrRe = /([^\s=/>]+)(?:="[^"]*")?/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRe.exec(match[2])) !== null) {
        attrs.add(attrMatch[1].toLowerCase());
      }
    }
    return { tags, attrs };
  }

  const INPUT = [
    "<script>alert(1)</script>",
    "｜<img src=x onerror=alert(1)>《よみ》",
    '［＃"><style>body{display:none}</style>］',
  ].join("\n\n");

  it("never emits a live <script> tag", () => {
    const doc = parseAozoraDocument(INPUT);
    const html = renderDocumentToHtml(doc);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never emits a live <img> tag or a live onerror attribute (only inert escaped text)", () => {
    const doc = parseAozoraDocument(INPUT);
    const html = renderDocumentToHtml(doc);
    expect(html).not.toMatch(/<img\b/);
    // "onerror=" surviving as part of already-escaped (&lt;...&gt;) text is
    // fine and expected — what must never happen is a REAL unescaped tag
    // carrying it as a live attribute.
    const { tags: liveTags } = (function collect() {
      const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
      const tags: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(html)) !== null) tags.push(m[0]);
      return { tags };
    })();
    expect(liveTags.some((tag) => /onerror/.test(tag))).toBe(false);
  });

  it("never emits a style attribute or a live <style> tag, and escapes the quote inside the annotation", () => {
    const doc = parseAozoraDocument(INPUT);
    const html = renderDocumentToHtml(doc);
    expect(html).not.toContain("<style>");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain("&quot;&gt;&lt;style&gt;");
  });

  it("never emits an external URL reference as a live src/href attribute", () => {
    const doc = parseAozoraDocument(INPUT);
    const html = renderDocumentToHtml(doc);
    expect(html).not.toMatch(/https?:\/\//);
    const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html)) !== null) {
      expect(m[0]).not.toMatch(/\s(?:src|href)\s*=/);
    }
  });

  it("only ever emits allowlisted tags and attributes for this whole input", () => {
    const doc = parseAozoraDocument(INPUT);
    const html = renderDocumentToHtml(doc) + renderBibliographyToHtml(doc.bibliography);
    const { tags, attrs } = collectTagsAndAttrs(html);
    for (const tag of tags) expect(ALLOWED_TAGS.has(tag)).toBe(true);
    for (const attr of attrs) expect(ALLOWED_ATTRS.has(attr)).toBe(true);
  });

  it("the ruby line's reading survives as inert escaped text, not a live tag", () => {
    const doc = parseAozoraDocument(INPUT);
    const html = renderDocumentToHtml(doc);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
