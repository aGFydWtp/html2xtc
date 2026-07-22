// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  extractPlainText,
  renderBibliographyToHtml,
  renderDocumentToHtml,
} from "../src/render-html";
import type { AozoraBlock, AozoraDocument } from "../src/types";

function doc(blocks: AozoraBlock[], bibliography: AozoraBlock[] = []): AozoraDocument {
  return { blocks, bibliography, diagnostics: [] };
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

describe("renderDocumentToHtml — heading", () => {
  it("maps level 1/2/3 to h2/h3/h4 with the size class", () => {
    const html = renderDocumentToHtml(
      doc([
        { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "大" }] },
        { type: "heading", level: 2, variant: "normal", children: [{ type: "text", value: "中" }] },
        { type: "heading", level: 3, variant: "normal", children: [{ type: "text", value: "小" }] },
      ]),
    );
    expect(html).toContain('<h2 class="aozora-heading aozora-heading-large">大</h2>');
    expect(html).toContain('<h3 class="aozora-heading aozora-heading-medium">中</h3>');
    expect(html).toContain('<h4 class="aozora-heading aozora-heading-small">小</h4>');
  });

  it("adds aozora-heading-inline for the inline variant", () => {
    const html = renderDocumentToHtml(
      doc([{ type: "heading", level: 2, variant: "inline", children: [{ type: "text", value: "見出し" }] }]),
    );
    expect(html).toContain(
      '<h3 class="aozora-heading aozora-heading-medium aozora-heading-inline">見出し</h3>',
    );
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
