// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { parseInlineText } from "../src/parse-inline";
import type { AozoraDiagnostic, AozoraInline } from "../src/types";
import { MAX_RUBY_READING_CODEPOINTS } from "../src/types";

function parse(chunk: string): { nodes: AozoraInline[]; diagnostics: AozoraDiagnostic[] } {
  const diagnostics: AozoraDiagnostic[] = [];
  const nodes = parseInlineText(chunk, { pushDiagnostic: (d) => diagnostics.push(d) });
  return { nodes, diagnostics };
}

describe("ruby (spec §9.1 / §18.2)", () => {
  it("explicit base marker", () => {
    const { nodes, diagnostics } = parse("｜倫敦警視庁《スコットランドヤード》");
    expect(nodes).toEqual([
      { type: "ruby", base: [{ type: "text", value: "倫敦警視庁" }], reading: "スコットランドヤード" },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("implicit base — kanji run", () => {
    const { nodes } = parse("漢字《かんじ》");
    expect(nodes).toEqual([{ type: "ruby", base: [{ type: "text", value: "漢字" }], reading: "かんじ" }]);
  });

  it("implicit base — katakana + chouon", () => {
    const { nodes } = parse("パン《ぱん》");
    expect(nodes).toEqual([{ type: "ruby", base: [{ type: "text", value: "パン" }], reading: "ぱん" }]);
  });

  it("implicit base only takes the valid-charset run, not the whole preceding text", () => {
    const { nodes } = parse("食べた漢字《かんじ》");
    expect(nodes).toEqual([
      { type: "text", value: "食べた" },
      { type: "ruby", base: [{ type: "text", value: "漢字" }], reading: "かんじ" },
    ]);
  });

  it("multiple rubies in the same paragraph", () => {
    const { nodes } = parse("山路《やまみち》を登《のぼ》る");
    expect(nodes).toEqual([
      { type: "ruby", base: [{ type: "text", value: "山路" }], reading: "やまみち" },
      { type: "text", value: "を" },
      { type: "ruby", base: [{ type: "text", value: "登" }], reading: "のぼ" },
      { type: "text", value: "る" },
    ]);
  });

  it("HTML special characters inside the reading are kept verbatim (escaped only at render time)", () => {
    const { nodes } = parse('｜漢字《"><script>》');
    expect(nodes).toEqual([
      { type: "ruby", base: [{ type: "text", value: "漢字" }], reading: '"><script>' },
    ]);
  });

  it("empty reading fails soft to literal text with a diagnostic", () => {
    const { nodes, diagnostics } = parse("漢字《》");
    expect(nodes).toEqual([{ type: "text", value: "漢字《》" }]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].kind).toBe("malformed-annotation");
  });

  it("unclosed ruby (no 》 before EOF) fails soft to literal text with a diagnostic", () => {
    const { nodes, diagnostics } = parse("漢字《読みかけ");
    expect(nodes).toEqual([{ type: "text", value: "漢字《読みかけ" }]);
    expect(diagnostics[0].kind).toBe("malformed-annotation");
  });

  it("no base found (Latin/digit/symbol immediately before 《 without ｜) fails soft with ruby-without-base", () => {
    const { nodes, diagnostics } = parse("Aozora《あおぞら》");
    expect(nodes).toEqual([{ type: "text", value: "Aozora《あおぞら》" }]);
    expect(diagnostics[0].kind).toBe("ruby-without-base");
  });

  it("Latin base is accepted when ｜ makes it explicit", () => {
    const { nodes, diagnostics } = parse("｜Aozora《あおぞら》");
    expect(nodes).toEqual([{ type: "ruby", base: [{ type: "text", value: "Aozora" }], reading: "あおぞら" }]);
    expect(diagnostics).toEqual([]);
  });

  it("reading over the 256-codepoint cap fails soft with resource-limit", () => {
    const reading = "あ".repeat(MAX_RUBY_READING_CODEPOINTS + 1);
    const { nodes, diagnostics } = parse(`漢字《${reading}》`);
    expect(nodes).toEqual([{ type: "text", value: `漢字《${reading}》` }]);
    expect(diagnostics[0].kind).toBe("resource-limit");
  });

  it("reading exactly at the 256-codepoint cap succeeds", () => {
    const reading = "あ".repeat(MAX_RUBY_READING_CODEPOINTS);
    const { nodes, diagnostics } = parse(`漢字《${reading}》`);
    expect(nodes).toEqual([{ type: "ruby", base: [{ type: "text", value: "漢字" }], reading }]);
    expect(diagnostics).toEqual([]);
  });

  it("reading crossing a newline fails soft with a diagnostic", () => {
    const { nodes, diagnostics } = parse("漢字《読み\n方》");
    expect(nodes).toEqual([{ type: "text", value: "漢字《読み\n方》" }]);
    expect(diagnostics[0].kind).toBe("malformed-annotation");
  });
});

describe("傍点 (spec §9.4)", () => {
  it("post-form wraps the immediately preceding target", () => {
    const { nodes } = parse("重要［＃「重要」に傍点］");
    expect(nodes).toEqual([{ type: "emphasis", style: "sesame", children: [{ type: "text", value: "重要" }] }]);
  });

  it("post-form only wraps the matched target, keeping surrounding text", () => {
    const { nodes } = parse("これは重要［＃「重要」に傍点］な話だ");
    expect(nodes).toEqual([
      { type: "text", value: "これは" },
      { type: "emphasis", style: "sesame", children: [{ type: "text", value: "重要" }] },
      { type: "text", value: "な話だ" },
    ]);
  });

  it("range-form wraps everything between ここから and ここで…終わり", () => {
    const { nodes } = parse("前置き［＃ここから傍点］重要な箇所［＃ここで傍点終わり］後書き");
    expect(nodes).toEqual([
      { type: "text", value: "前置き" },
      { type: "emphasis", style: "sesame", children: [{ type: "text", value: "重要な箇所" }] },
      { type: "text", value: "後書き" },
    ]);
  });

  it("maps every documented dot style", () => {
    const cases: Array<[string, string]> = [
      ["傍点", "sesame"],
      ["白ゴマ傍点", "white-sesame"],
      ["黒丸傍点", "black-circle"],
      ["白丸傍点", "white-circle"],
      ["黒三角傍点", "black-triangle"],
      ["白三角傍点", "white-triangle"],
      ["二重丸傍点", "bullseye"],
      ["蛇の目傍点", "fisheye"],
      ["ばつ傍点", "saltire"],
    ];
    for (const [label, style] of cases) {
      const { nodes } = parse(`重要［＃「重要」に${label}］`);
      expect(nodes).toEqual([{ type: "emphasis", style, children: [{ type: "text", value: "重要" }] }]);
    }
  });

  it("post-form target not found fails soft with a diagnostic", () => {
    const { nodes, diagnostics } = parse("何か［＃「見つからない」に傍点］");
    expect(nodes).toEqual([
      { type: "text", value: "何か" },
      { type: "rawAnnotation", text: "［＃「見つからない」に傍点］" },
    ]);
    expect(diagnostics[0].kind).toBe("malformed-annotation");
  });
});

describe("傍線・上線・太字・斜体 (spec §9.5)", () => {
  it("post-form underline/overline/bold/italic", () => {
    expect(parse("下線［＃「下線」に傍線］").nodes).toEqual([
      { type: "decoration", style: "underline", children: [{ type: "text", value: "下線" }] },
    ]);
    expect(parse("上線部［＃「上線部」に上線］").nodes).toEqual([
      { type: "decoration", style: "overline", children: [{ type: "text", value: "上線部" }] },
    ]);
    expect(parse("太字部［＃「太字部」に太字］").nodes).toEqual([
      { type: "decoration", style: "bold", children: [{ type: "text", value: "太字部" }] },
    ]);
    expect(parse("斜体部［＃「斜体部」に斜体］").nodes).toEqual([
      { type: "decoration", style: "italic", children: [{ type: "text", value: "斜体部" }] },
    ]);
  });

  it("range-form decoration", () => {
    const { nodes } = parse("［＃ここから太字］重要な部分［＃ここで太字終わり］");
    expect(nodes).toEqual([{ type: "decoration", style: "bold", children: [{ type: "text", value: "重要な部分" }] }]);
  });
});

describe("縦中横 (spec §9.9)", () => {
  it("wraps the preceding digits in a tcy node", () => {
    const { nodes } = parse("12［＃「12」は縦中横］月");
    expect(nodes).toEqual([
      { type: "tcy", children: [{ type: "text", value: "12" }] },
      { type: "text", value: "月" },
    ]);
  });
});

describe("外字 (spec §9.10)", () => {
  it("resolves a valid U+XXXX to the real character and consumes the ※ marker", () => {
    const { nodes, diagnostics } = parse("※［＃「土へん＋奇」、U+57FC］");
    expect(nodes).toEqual([{ type: "gaiji", unicode: "\u{57FC}", description: "土へん＋奇" }]);
    expect(diagnostics).toEqual([]);
  });

  it("with no Unicode spec at all, falls back to description-only", () => {
    const { nodes } = parse("※［＃「土へん＋奇」］");
    expect(nodes).toEqual([{ type: "gaiji", description: "土へん＋奇" }]);
  });

  it("rejects a surrogate-half code point, falling back to description-only", () => {
    const { nodes } = parse("※［＃「x」、U+D800］");
    expect(nodes).toEqual([{ type: "gaiji", description: "x" }]);
  });

  it("rejects a code point past U+10FFFF, falling back to description-only", () => {
    const { nodes } = parse("※［＃「x」、U+110000］");
    expect(nodes).toEqual([{ type: "gaiji", description: "x" }]);
  });

  it("rejects a noncharacter code point, falling back to description-only", () => {
    const { nodes } = parse("※［＃「x」、U+FFFE］");
    expect(nodes).toEqual([{ type: "gaiji", description: "x" }]);
  });

  it("rejects malformed hex, falling back to description-only", () => {
    const { nodes } = parse("※［＃「x」、U+ZZZZ］");
    expect(nodes).toEqual([{ type: "gaiji", description: "x" }]);
  });
});

describe("未対応注記 (spec §9.11)", () => {
  it("keeps an unrecognized annotation visible, escaped, wrapped in rawAnnotation", () => {
    const { nodes, diagnostics } = parse("本文［＃謎の注記］続き");
    expect(nodes).toEqual([
      { type: "text", value: "本文" },
      { type: "rawAnnotation", text: "［＃謎の注記］" },
      { type: "text", value: "続き" },
    ]);
    expect(diagnostics[0].kind).toBe("unsupported-annotation");
  });
});

describe("range nesting limit (spec §17)", () => {
  it("caps nesting at MAX_RANGE_NESTING_DEPTH and fails soft beyond it", () => {
    const opens = "［＃ここから傍点］".repeat(40);
    const closes = "［＃ここで傍点終わり］".repeat(40);
    const { diagnostics } = parse(opens + "x" + closes);
    expect(diagnostics.some((d) => d.kind === "resource-limit")).toBe(true);
  });
});

describe("unmatched / unclosed ranges", () => {
  it("an end marker with no matching start fails soft with unmatched-end", () => {
    const { nodes, diagnostics } = parse("［＃ここで傍点終わり］");
    expect(nodes).toEqual([{ type: "rawAnnotation", text: "［＃ここで傍点終わり］" }]);
    expect(diagnostics[0].kind).toBe("unmatched-end");
  });

  it("a start marker never closed within the paragraph fails soft with unclosed-range, keeping content visible", () => {
    const { nodes, diagnostics } = parse("［＃ここから傍点］重要");
    expect(nodes).toEqual([
      { type: "rawAnnotation", text: "［＃ここから傍点］" },
      { type: "text", value: "重要" },
    ]);
    expect(diagnostics[0].kind).toBe("unclosed-range");
  });
});

describe("annotation-body size cap (spec §17)", () => {
  it("an annotation body over 4096 codepoints falls back to literal text", () => {
    const body = "x".repeat(4097);
    const { nodes, diagnostics } = parse(`前［＃${body}］後`);
    expect(nodes).toEqual([{ type: "text", value: `前［＃${body}］後` }]);
    expect(diagnostics[0].kind).toBe("resource-limit");
  });

  it("an annotation body at exactly 4096 codepoints is still interpreted normally", () => {
    // rawBody = "「" + label + "」に傍点" → 1 + label.length + 4 codepoints.
    const label = "x".repeat(4091);
    const { nodes, diagnostics } = parse(`前${label}［＃「${label}」に傍点］`);
    expect(diagnostics).toEqual([]);
    expect(nodes[nodes.length - 1]).toEqual({
      type: "emphasis",
      style: "sesame",
      children: [{ type: "text", value: label }],
    });
  });
});

describe("security", () => {
  it("HTML in plain text stays a literal text node (escaping is render-html.ts's job)", () => {
    const { nodes } = parse("<script>alert(1)</script>");
    expect(nodes).toEqual([{ type: "text", value: "<script>alert(1)</script>" }]);
  });

  it("HTML inside an explicit ruby base stays literal text, not reinterpreted", () => {
    const { nodes } = parse("｜<img src=x onerror=alert(1)>《よみ》");
    expect(nodes).toEqual([
      { type: "ruby", base: [{ type: "text", value: "<img src=x onerror=alert(1)>" }], reading: "よみ" },
    ]);
  });

  it("a style/attribute breakout attempt inside an annotation stays literal raw text", () => {
    const { nodes } = parse('［＃"><style>body{display:none}</style>］');
    expect(nodes).toEqual([
      { type: "rawAnnotation", text: '［＃"><style>body{display:none}</style>］' },
    ]);
  });
});
