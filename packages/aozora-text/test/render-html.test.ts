// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  determineChapterHeadingLevel,
  extractChapters,
  extractPlainText,
  renderBibliographyToHtml,
  renderDocumentToHtml,
} from "../src/render-html";
import type { XtcChapter } from "../src/chapters";
import type { AozoraBlock, AozoraDocument } from "../src/types";

function doc(blocks: AozoraBlock[], bibliography: AozoraBlock[] = []): AozoraDocument {
  return { blocks, bibliography, diagnostics: [] };
}

/** extractChapters returns { chapters, headingLevel } (its own doc comment
 * explains why: a caller that also needs the level, e.g.
 * src/text-prepare.ts's prepareAozora, reads it off this one call instead of
 * separately calling determineChapterHeadingLevel again). Most assertions
 * below only care about the chapter list itself. */
function chaptersOf(document: AozoraDocument): XtcChapter[] {
  return extractChapters(document).chapters;
}

describe("renderDocumentToHtml — paragraph", () => {
  it("renders a plain paragraph with no class attribute", () => {
    const html = renderDocumentToHtml(
      doc([{ type: "paragraph", children: [{ type: "text", value: "本文です。" }] }]),
    );
    expect(html).toBe("<p>本文です。</p>");
  });

  it("converts embedded newlines in a text node to <br>", () => {
    const html = renderDocumentToHtml(
      doc([{ type: "paragraph", children: [{ type: "text", value: "一行目\n二行目" }] }]),
    );
    expect(html).toBe("<p>一行目<br>二行目</p>");
  });

  it("emits jisage_N for a start-indented paragraph", () => {
    const html = renderDocumentToHtml(
      doc([
        {
          type: "paragraph",
          indentEm: 3,
          children: [{ type: "text", value: "字下げ" }],
        },
      ]),
    );
    expect(html).toBe('<p class="jisage_3">字下げ</p>');
  });

  it("emits chitsuki_0 for align=end with no indentEm", () => {
    const html = renderDocumentToHtml(
      doc([{ type: "paragraph", align: "end", children: [{ type: "text", value: "地付き" }] }]),
    );
    expect(html).toBe('<p class="chitsuki_0">地付き</p>');
  });

  it("emits chitsuki_N for align=end with an indentEm", () => {
    const html = renderDocumentToHtml(
      doc([
        {
          type: "paragraph",
          align: "end",
          indentEm: 3,
          children: [{ type: "text", value: "地から3字上げ" }],
        },
      ]),
    );
    expect(html).toBe('<p class="chitsuki_3">地から3字上げ</p>');
  });

  it("emits aozora-center for align=center", () => {
    const html = renderDocumentToHtml(
      doc([{ type: "paragraph", align: "center", children: [{ type: "text", value: "中央" }] }]),
    );
    expect(html).toBe('<p class="aozora-center">中央</p>');
  });
});

describe("renderDocumentToHtml — 罫囲み (boxed paragraph grouping)", () => {
  it("wraps a single boxed paragraph in one aozora-box div", () => {
    const html = renderDocumentToHtml(
      doc([{ type: "paragraph", boxed: true, children: [{ type: "text", value: "枠の中" }] }]),
    );
    expect(html).toBe('<div class="aozora-box">\n<p>枠の中</p>\n</div>');
  });

  it("groups several consecutive boxed paragraphs into ONE div, not one per paragraph", () => {
    const html = renderDocumentToHtml(
      doc([
        { type: "paragraph", boxed: true, children: [{ type: "text", value: "行1" }] },
        { type: "paragraph", boxed: true, children: [{ type: "text", value: "行2" }] },
        { type: "paragraph", boxed: true, children: [{ type: "text", value: "行3" }] },
      ]),
    );
    const boxOpenCount = (html.match(/<div class="aozora-box">/g) ?? []).length;
    expect(boxOpenCount).toBe(1);
    expect(html).toBe('<div class="aozora-box">\n<p>行1</p>\n<p>行2</p>\n<p>行3</p>\n</div>');
  });

  it("does not pull a non-boxed paragraph into a neighboring box, on either side", () => {
    const html = renderDocumentToHtml(
      doc([
        { type: "paragraph", children: [{ type: "text", value: "枠外1" }] },
        { type: "paragraph", boxed: true, children: [{ type: "text", value: "枠内" }] },
        { type: "paragraph", children: [{ type: "text", value: "枠外2" }] },
      ]),
    );
    expect(html).toBe(
      '<p>枠外1</p>\n<div class="aozora-box">\n<p>枠内</p>\n</div>\n<p>枠外2</p>',
    );
  });

  it("starts a new box for a second, separate run of boxed paragraphs", () => {
    const html = renderDocumentToHtml(
      doc([
        { type: "paragraph", boxed: true, children: [{ type: "text", value: "枠1" }] },
        { type: "paragraph", children: [{ type: "text", value: "間の段落" }] },
        { type: "paragraph", boxed: true, children: [{ type: "text", value: "枠2" }] },
      ]),
    );
    const boxOpenCount = (html.match(/<div class="aozora-box">/g) ?? []).length;
    expect(boxOpenCount).toBe(2);
  });

  it("a boxed paragraph keeps its own jisage_N/aozora-center class inside the box", () => {
    const html = renderDocumentToHtml(
      doc([{ type: "paragraph", boxed: true, align: "center", children: [{ type: "text", value: "中央かつ枠" }] }]),
    );
    expect(html).toBe('<div class="aozora-box">\n<p class="aozora-center">中央かつ枠</p>\n</div>');
  });

  it("also groups boxed paragraphs inside the 底本 bibliography", () => {
    const html = renderBibliographyToHtml([
      { type: "paragraph", boxed: true, children: [{ type: "text", value: "行1" }] },
      { type: "paragraph", boxed: true, children: [{ type: "text", value: "行2" }] },
    ]);
    const boxOpenCount = (html.match(/<div class="aozora-box">/g) ?? []).length;
    expect(boxOpenCount).toBe(1);
  });
});

describe("renderDocumentToHtml — heading", () => {
  it("maps level 1/2/3 to h2/h3/h4 with the size class", () => {
    const html = renderDocumentToHtml(
      doc([
        { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "大" }] },
        { type: "heading", level: 2, variant: "normal", children: [{ type: "text", value: "中" }] },
        { type: "heading", level: 3, variant: "normal", children: [{ type: "text", value: "小" }] },
      ]),
    );
    // Level 1 (大見出し) is present, so it — not level 2 — is this
    // document's chapter level (A-1) and gets an XTC chapter-marker span
    // prepended; see the "chapter granularity" describe block below for
    // dedicated coverage of that either/or contract.
    expect(html).toContain(
      '<h2 class="aozora-heading aozora-heading-large"><span class="xtc-chapter-marker" aria-hidden="true">XTCCH0001</span>大</h2>',
    );
    expect(html).toContain('<h3 class="aozora-heading aozora-heading-medium">中</h3>');
    expect(html).toContain('<h4 class="aozora-heading aozora-heading-small">小</h4>');
  });

  it("adds aozora-heading-inline for the inline variant (and a marker, since level 2 is this document's ONLY heading level)", () => {
    const html = renderDocumentToHtml(
      doc([{ type: "heading", level: 2, variant: "inline", children: [{ type: "text", value: "見出し" }] }]),
    );
    // No level-1 heading anywhere in this document, so level 2 is the
    // fallback chapter level (A-1) — this heading DOES get a marker.
    expect(html).toContain(
      '<h3 class="aozora-heading aozora-heading-medium aozora-heading-inline"><span class="xtc-chapter-marker" aria-hidden="true">XTCCH0001</span>見出し</h3>',
    );
  });
});

describe("determineChapterHeadingLevel / renderDocumentToHtml / extractChapters — chapter granularity (A-1: 大 if present, else 中, never both, 小 never a source)", () => {
  function levelsDoc(levels: Array<1 | 2 | 3>): AozoraDocument {
    return doc(
      levels.map((level, i) => ({
        type: "heading" as const,
        level,
        variant: "normal" as const,
        children: [{ type: "text" as const, value: `見出し${i + 1}` }],
      })),
    );
  }

  it("大 present (with 中/小 also present): only 大 becomes the chapter level, 中/小 stay unmarked/unlisted", () => {
    const document = levelsDoc([1, 2, 3, 1]);
    expect(determineChapterHeadingLevel(document)).toBe(1);
    const html = renderDocumentToHtml(document);
    expect(html.match(/xtc-chapter-marker/g)).toHaveLength(2); // one per 大, none for 中/小
    expect(chaptersOf(document)).toEqual([
      { name: "見出し1", marker: "XTCCH0001" },
      { name: "見出し4", marker: "XTCCH0002" },
    ]);
    // extractChapters's own headingLevel must agree with the standalone
    // determineChapterHeadingLevel call above — the two are never allowed
    // to drift apart (this is exactly what folding the level into
    // extractChapters's return value guards against).
    expect(extractChapters(document).headingLevel).toBe(determineChapterHeadingLevel(document));
  });

  it("中 present, no 大 (小 also present): 中 becomes the chapter level, 小 stays unmarked/unlisted", () => {
    const document = levelsDoc([2, 3, 2]);
    expect(determineChapterHeadingLevel(document)).toBe(2);
    const html = renderDocumentToHtml(document);
    expect(html.match(/xtc-chapter-marker/g)).toHaveLength(2); // one per 中, none for 小
    expect(chaptersOf(document)).toEqual([
      { name: "見出し1", marker: "XTCCH0001" },
      { name: "見出し3", marker: "XTCCH0002" },
    ]);
    expect(extractChapters(document).headingLevel).toBe(determineChapterHeadingLevel(document));
  });

  it("only 小 present: null (小 is never a chapter source, no fallback below it)", () => {
    const document = levelsDoc([3, 3]);
    expect(determineChapterHeadingLevel(document)).toBeNull();
    const html = renderDocumentToHtml(document);
    expect(html).not.toContain("xtc-chapter-marker");
    expect(chaptersOf(document)).toEqual([]);
    expect(extractChapters(document).headingLevel).toBeNull();
  });

  it("no heading at all: null", () => {
    const document = doc([{ type: "paragraph", children: [{ type: "text", value: "本文" }] }]);
    expect(determineChapterHeadingLevel(document)).toBeNull();
    expect(chaptersOf(document)).toEqual([]);
    expect(extractChapters(document).headingLevel).toBeNull();
  });

  it("never numbers a bibliography heading (renderBibliographyToHtml never embeds a marker)", () => {
    const html = renderBibliographyToHtml([
      { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "底本" }] },
    ]);
    expect(html).not.toContain("xtc-chapter-marker");
  });
});

describe("extractChapters — name normalization and empty-name boundary cases (B-4)", () => {
  it("normalizes the chapter name: collapses embedded newlines and ruby readings are excluded", () => {
    const withRubyAndNewline = doc([
      {
        type: "heading",
        level: 1,
        variant: "normal",
        children: [
          { type: "text", value: "第\n一" },
          { type: "ruby", base: [{ type: "text", value: "章" }], reading: "しょう" },
        ],
      },
    ]);
    expect(chaptersOf(withRubyAndNewline)).toEqual([{ name: "第 一章", marker: "XTCCH0001" }]);
  });

  it("excludes rawAnnotation notation from the chapter name", () => {
    const withRawAnnotation = doc([
      {
        type: "heading",
        level: 1,
        variant: "normal",
        children: [
          { type: "text", value: "序" },
          { type: "rawAnnotation", text: "［＃未対応の注記］" },
        ],
      },
    ]);
    expect(chaptersOf(withRawAnnotation)).toEqual([{ name: "序", marker: "XTCCH0001" }]);
  });

  it("skips a heading with no children at all (empty name) — neither numbered, marked, nor listed", () => {
    const document = doc([
      { type: "heading", level: 1, variant: "normal", children: [] },
      { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "実在の章" }] },
    ]);
    // The empty heading is skipped outright: the surviving chapter keeps
    // marker 1 (numbering is never "reserved" for a skipped heading), and
    // its marker is the only one embedded in the HTML.
    expect(chaptersOf(document)).toEqual([{ name: "実在の章", marker: "XTCCH0001" }]);
    const html = renderDocumentToHtml(document);
    expect(html.match(/xtc-chapter-marker/g)).toHaveLength(1);
    expect(html).toContain(
      '<h2 class="aozora-heading aozora-heading-large"><span class="xtc-chapter-marker" aria-hidden="true">XTCCH0001</span>実在の章</h2>',
    );
  });

  it("skips a heading built only from an empty ruby base (whitespace-only or absent text)", () => {
    const document = doc([
      {
        type: "heading",
        level: 1,
        variant: "normal",
        children: [{ type: "ruby", base: [{ type: "text", value: "" }], reading: "からのみだし" }],
      },
    ]);
    expect(chaptersOf(document)).toEqual([]);
    expect(renderDocumentToHtml(document)).not.toContain("xtc-chapter-marker");
  });

  it("skips a heading built only from a rawAnnotation (notation-only, no readable text at all)", () => {
    const document = doc([
      { type: "heading", level: 1, variant: "normal", children: [{ type: "rawAnnotation", text: "［＃未対応の注記］" }] },
    ]);
    expect(chaptersOf(document)).toEqual([]);
    expect(renderDocumentToHtml(document)).not.toContain("xtc-chapter-marker");
  });

  it("skips a heading whose only text is whitespace", () => {
    const document = doc([
      { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "　\n　" }] },
    ]);
    expect(chaptersOf(document)).toEqual([]);
    expect(renderDocumentToHtml(document)).not.toContain("xtc-chapter-marker");
  });

  it("numbering stays contiguous across a skipped empty heading sandwiched between two real ones", () => {
    const document = doc([
      { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "序" }] },
      { type: "heading", level: 1, variant: "normal", children: [] },
      { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "結び" }] },
    ]);
    expect(chaptersOf(document)).toEqual([
      { name: "序", marker: "XTCCH0001" },
      { name: "結び", marker: "XTCCH0002" },
    ]);
    const html = renderDocumentToHtml(document);
    expect(html.match(/xtc-chapter-marker/g)).toHaveLength(2);
  });
});

describe("renderDocumentToHtml — pageBreak", () => {
  it("renders every kind as the same page-break div", () => {
    for (const kind of ["page", "sheet", "spread", "column"] as const) {
      const html = renderDocumentToHtml(doc([{ type: "pageBreak", kind }]));
      expect(html).toBe('<div class="aozora-page-break" aria-hidden="true"></div>');
    }
  });
});

describe("renderDocumentToHtml — rawAnnotation block", () => {
  it("keeps the original text, escaped, wrapped in aozora-raw-note", () => {
    const html = renderDocumentToHtml(doc([{ type: "rawAnnotation", text: "［＃未対応の注記］" }]));
    expect(html).toBe('<p><span class="aozora-raw-note">［＃未対応の注記］</span></p>');
  });
});

describe("renderDocumentToHtml — ruby", () => {
  it("renders explicit base + reading with rp fallback parentheses", () => {
    const html = renderDocumentToHtml(
      doc([
        {
          type: "paragraph",
          children: [
            {
              type: "ruby",
              base: [{ type: "text", value: "倫敦警視庁" }],
              reading: "スコットランドヤード",
            },
          ],
        },
      ]),
    );
    expect(html).toBe(
      "<p><ruby><rb>倫敦警視庁</rb><rp>（</rp><rt>スコットランドヤード</rt><rp>）</rp></ruby></p>",
    );
  });

  it("escapes base and reading independently", () => {
    const html = renderDocumentToHtml(
      doc([
        {
          type: "paragraph",
          children: [
            {
              type: "ruby",
              base: [{ type: "text", value: "<b>" }],
              reading: `"><script>`,
            },
          ],
        },
      ]),
    );
    expect(html).toContain("<rb>&lt;b&gt;</rb>");
    expect(html).toContain("<rt>&quot;&gt;&lt;script&gt;</rt>");
    expect(html).not.toContain("<script>");
  });
});

describe("renderDocumentToHtml — emphasis / decoration / tcy / gaiji", () => {
  it("maps every emphasis style to its CSS class", () => {
    const styles: Array<[string, string]> = [
      ["sesame", "sesame_dot"],
      ["white-sesame", "white_sesame_dot"],
      ["black-circle", "black_circle"],
      ["white-circle", "white_circle"],
      ["black-triangle", "black_up-pointing_triangle"],
      ["white-triangle", "white_up-pointing_triangle"],
      ["bullseye", "bullseye"],
      ["fisheye", "fisheye"],
      ["saltire", "saltire"],
    ];
    for (const [style, cls] of styles) {
      const html = renderDocumentToHtml(
        doc([
          {
            type: "paragraph",
            children: [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { type: "emphasis", style: style as any, children: [{ type: "text", value: "重要" }] },
            ],
          },
        ]),
      );
      expect(html).toBe(`<p><em class="${cls}">重要</em></p>`);
    }
  });

  it("renders decoration styles", () => {
    const render = (style: "underline" | "overline" | "bold" | "italic") =>
      renderDocumentToHtml(
        doc([
          {
            type: "paragraph",
            children: [{ type: "decoration", style, children: [{ type: "text", value: "x" }] }],
          },
        ]),
      );
    expect(render("underline")).toBe('<p><span class="underline_solid">x</span></p>');
    expect(render("overline")).toBe('<p><span class="overline_solid">x</span></p>');
    expect(render("bold")).toBe("<p><strong>x</strong></p>");
    expect(render("italic")).toBe('<p><em class="shatai">x</em></p>');
  });

  it("renders tcy as a span.tcy", () => {
    const html = renderDocumentToHtml(
      doc([
        {
          type: "paragraph",
          children: [{ type: "tcy", children: [{ type: "text", value: "12" }] }],
        },
      ]),
    );
    expect(html).toBe('<p><span class="tcy">12</span></p>');
  });

  it("renders a resolved gaiji unicode character as plain escaped text", () => {
    const html = renderDocumentToHtml(
      doc([
        {
          type: "paragraph",
          children: [{ type: "gaiji", unicode: "\u{57FC}", description: "土へん＋奇" }],
        },
      ]),
    );
    expect(html).toBe("<p>\u{57FC}</p>");
  });

  it("renders an unresolved gaiji as a fallback glyph with escaped title", () => {
    const html = renderDocumentToHtml(
      doc([
        {
          type: "paragraph",
          children: [{ type: "gaiji", description: `土へん"＋奇` }],
        },
      ]),
    );
    expect(html).toBe('<p><span class="gaiji-fallback" title="土へん&quot;＋奇">〓</span></p>');
  });
});

describe("renderBibliographyToHtml", () => {
  it("returns an empty string for an empty bibliography", () => {
    expect(renderBibliographyToHtml([])).toBe("");
  });

  it("wraps bibliography blocks in .bibliographical_information", () => {
    const html = renderBibliographyToHtml([
      { type: "paragraph", children: [{ type: "text", value: "底本：「草枕」" }] },
    ]);
    expect(html).toContain('<div class="bibliographical_information">');
    expect(html).toContain("<p>底本：「草枕」</p>");
  });
});

describe("extractPlainText", () => {
  it("flattens text, ruby base+reading, and gaiji description across blocks", () => {
    const text = extractPlainText(
      doc(
        [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "山路を" },
              { type: "ruby", base: [{ type: "text", value: "登" }], reading: "のぼ" },
            ],
          },
        ],
        [{ type: "paragraph", children: [{ type: "text", value: "底本：テスト" }] }],
      ),
    );
    expect(text).toContain("山路を");
    expect(text).toContain("登");
    expect(text).toContain("のぼ");
    expect(text).toContain("底本：テスト");
  });
});
