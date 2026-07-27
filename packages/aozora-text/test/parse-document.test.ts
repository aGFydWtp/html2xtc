// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { AozoraAstLimitExceededError, parseAozoraDocument } from "../src/parse-document";
import type { AozoraBlock } from "../src/types";
import { MAX_DIAGNOSTICS, MAX_RANGE_NESTING_DEPTH } from "../src/types";

describe("改ページ (spec §9.2 / §18.3 — all 4 kinds)", () => {
  it("recognizes 改ページ／改丁／改見開き／改段 as their own pageBreak block", () => {
    const doc = parseAozoraDocument(
      ["本文1", "", "［＃改ページ］", "", "本文2", "", "［＃改丁］", "", "本文3", "", "［＃改見開き］", "", "本文4", "", "［＃改段］", "", "本文5"].join(
        "\n",
      ),
    );
    const kinds = doc.blocks.filter((b) => b.type === "pageBreak").map((b) => (b as { kind: string }).kind);
    expect(kinds).toEqual(["page", "sheet", "spread", "column"]);
  });
});

describe("見出し (spec §9.3 / §18.3)", () => {
  it("recognizes a 大見出し via the same-line quoted form", () => {
    const doc = parseAozoraDocument("第一章［＃「第一章」は大見出し］");
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "第一章" }] },
    ]);
  });

  it("recognizes a 中見出し via the range form", () => {
    const doc = parseAozoraDocument("［＃ここから中見出し］第二章［＃ここで中見出し終わり］");
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "heading", level: 2, variant: "normal", children: [{ type: "text", value: "第二章" }] },
    ]);
  });

  it("recognizes a 小見出し", () => {
    const doc = parseAozoraDocument("節１［＃「節１」は小見出し］");
    expect(doc.blocks[0]).toEqual({
      type: "heading",
      level: 3,
      variant: "normal",
      children: [{ type: "text", value: "節１" }],
    });
  });

  it("recognizes the 同行 (inline) variant", () => {
    const doc = parseAozoraDocument("［＃ここから同行中見出し］小節［＃ここで同行中見出し終わり］");
    expect(doc.blocks[0]).toMatchObject({ type: "heading", level: 2, variant: "inline" });
  });

  it("recognizes the 窓 (window) variant", () => {
    const doc = parseAozoraDocument("［＃ここから窓小見出し］小節［＃ここで窓小見出し終わり］");
    expect(doc.blocks[0]).toMatchObject({ type: "heading", level: 3, variant: "window" });
  });

  it("a heading annotation whose quoted target doesn't match the preceding text falls back to unsupported-annotation", () => {
    const doc = parseAozoraDocument("違う文字列［＃「一致しない」は大見出し］");
    expect(doc.blocks[0].type).toBe("paragraph");
    expect(doc.diagnostics.some((d) => d.kind === "unsupported-annotation")).toBe(true);
  });
});

describe("字下げ (spec §9.6 / §18.3)", () => {
  it("a single ［＃N字下げ］ applies only to the next paragraph", () => {
    const doc = parseAozoraDocument("［＃3字下げ］\n\n字下げされた段落\n\n通常の段落");
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", indentEm: 3, children: [{ type: "text", value: "字下げされた段落" }] },
      { type: "paragraph", children: [{ type: "text", value: "通常の段落" }] },
    ]);
  });

  it("a ここから／ここで range applies to every paragraph in between", () => {
    const doc = parseAozoraDocument(
      "［＃ここから3字下げ］\n\n段落1\n\n段落2\n\n［＃ここで字下げ終わり］\n\n通常の段落",
    );
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", indentEm: 3, children: [{ type: "text", value: "段落1" }] },
      { type: "paragraph", indentEm: 3, children: [{ type: "text", value: "段落2" }] },
      { type: "paragraph", children: [{ type: "text", value: "通常の段落" }] },
    ]);
  });

  it("0em and 30em are both allowed", () => {
    const doc = parseAozoraDocument("［＃30字下げ］\n\n本文");
    expect(doc.blocks[0]).toMatchObject({ indentEm: 30 });
  });

  it("31+ em is treated as an unsupported annotation, not clamped to 30", () => {
    const doc = parseAozoraDocument("［＃31字下げ］\n\n本文");
    expect(doc.blocks[0].type).toBe("rawAnnotation");
    expect(doc.blocks[1]).toEqual({ type: "paragraph", children: [{ type: "text", value: "本文" }] });
    expect(doc.diagnostics[0].kind).toBe("unsupported-annotation");
  });
});

describe("地付き・地からの字上げ (spec §9.7 / §18.3)", () => {
  it("［＃地付き］ sets align=end with no indent", () => {
    const doc = parseAozoraDocument("［＃地付き］\n\n右寄せの本文");
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", align: "end", children: [{ type: "text", value: "右寄せの本文" }] },
    ]);
  });

  it("［＃地からN字上げ］ sets align=end with an indent", () => {
    const doc = parseAozoraDocument("［＃地から3字上げ］\n\n本文");
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", align: "end", indentEm: 3, children: [{ type: "text", value: "本文" }] },
    ]);
  });
});

describe("中央寄せ (spec §9.8 / §18.3)", () => {
  it("a single ［＃中央寄せ］ applies to the next paragraph only", () => {
    const doc = parseAozoraDocument("［＃中央寄せ］\n\n中央の本文\n\n通常の本文");
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", align: "center", children: [{ type: "text", value: "中央の本文" }] },
      { type: "paragraph", children: [{ type: "text", value: "通常の本文" }] },
    ]);
  });

  it("a range applies to every paragraph in between", () => {
    const doc = parseAozoraDocument(
      "［＃ここから中央寄せ］\n\n段落1\n\n段落2\n\n［＃ここで中央寄せ終わり］\n\n通常",
    );
    expect(doc.blocks.slice(0, 2)).toEqual<AozoraBlock[]>([
      { type: "paragraph", align: "center", children: [{ type: "text", value: "段落1" }] },
      { type: "paragraph", align: "center", children: [{ type: "text", value: "段落2" }] },
    ]);
    expect(doc.blocks[2]).toEqual({ type: "paragraph", children: [{ type: "text", value: "通常" }] });
  });
});

describe("broken / mismatched range annotations (spec §18.3)", () => {
  it("an end-only range marker (no matching start) fails soft as a raw annotation, keeping the body", () => {
    const doc = parseAozoraDocument("［＃ここで字下げ終わり］\n\n本文");
    expect(doc.blocks.some((b) => b.type === "rawAnnotation")).toBe(true);
    expect(doc.blocks.some((b) => b.type === "paragraph")).toBe(true);
    expect(doc.diagnostics.some((d) => d.kind === "unmatched-end")).toBe(true);
  });

  it("a start-only range marker (never closed) still keeps the body content visible", () => {
    const doc = parseAozoraDocument("［＃ここから3字下げ］\n\n本文1\n\n本文2");
    const paragraphs = doc.blocks.filter((b) => b.type === "paragraph");
    expect(paragraphs.map((p) => (p as { children: unknown }).children)).toEqual([
      [{ type: "text", value: "本文1" }],
      [{ type: "text", value: "本文2" }],
    ]);
    expect(doc.diagnostics.some((d) => d.kind === "unclosed-range")).toBe(true);
  });

  it("caps range nesting depth (spec §17)", () => {
    const opens = Array.from({ length: 40 }, (_, i) => `［＃ここから${(i % 30) + 1}字下げ］`).join("\n\n");
    const closes = Array.from({ length: 40 }, () => "［＃ここで字下げ終わり］").join("\n\n");
    const doc = parseAozoraDocument(`${opens}\n\n本文\n\n${closes}`);
    expect(doc.diagnostics.some((d) => d.kind === "resource-limit")).toBe(true);
  });
});

describe("未対応注記 fail-soft — malformed / broken annotations never lose text", () => {
  it("a broken/unrecognized annotation stays visible as a raw note", () => {
    const doc = parseAozoraDocument("本文の前［＃壊れた注記］本文の後");
    expect(doc.blocks[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", value: "本文の前" },
        { type: "rawAnnotation", text: "［＃壊れた注記］" },
        { type: "text", value: "本文の後" },
      ],
    });
  });
});

describe("diagnostics cap (spec §7.4/§17)", () => {
  it("stops appending diagnostics past MAX_DIAGNOSTICS but keeps parsing the rest of the document", () => {
    const paragraphs = Array.from({ length: MAX_DIAGNOSTICS + 50 }, (_, i) => `本文${i}［＃謎注記${i}］`).join(
      "\n\n",
    );
    const doc = parseAozoraDocument(paragraphs);
    expect(doc.diagnostics.length).toBe(MAX_DIAGNOSTICS);
    expect(doc.blocks.length).toBe(MAX_DIAGNOSTICS + 50);
  });
});

describe("AST node limit (spec §17 — deterministic failure, not a partial document)", () => {
  it("throws AozoraAstLimitExceededError once the node count would exceed MAX_AST_NODES", () => {
    const paragraphs = Array.from({ length: 1_000_001 }, (_, i) => `p${i}`).join("\n\n");
    expect(() => parseAozoraDocument(paragraphs)).toThrow(AozoraAstLimitExceededError);
  });

  it("the thrown error's message never contains document content", () => {
    const paragraphs = Array.from({ length: 1_000_001 }, (_, i) => `secret-body-text-${i}`).join("\n\n");
    try {
      parseAozoraDocument(paragraphs);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AozoraAstLimitExceededError);
      expect((error as Error).message).not.toContain("secret-body-text");
    }
  });

  it("does not throw just under the limit", () => {
    const paragraphs = Array.from({ length: 200_000 }, (_, i) => `p${i}`).join("\n\n");
    expect(() => parseAozoraDocument(paragraphs)).not.toThrow();
  });
});

describe("block control annotations without any blank lines (regression: real files that never blank-line-separate 改ページ／見出し from surrounding prose)", () => {
  function textOf(children: unknown): string {
    return (children as { type: string; value?: string }[])
      .map((c) => (c.type === "text" ? (c.value ?? "") : ""))
      .join("");
  }

  it("改ページ alone on its own line, with real content on the lines around it, is still a pageBreak block", () => {
    const doc = parseAozoraDocument(["本文の前の行", "［＃改ページ］", "本文の後の行"].join("\n"));
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", children: [{ type: "text", value: "本文の前の行" }] },
      { type: "pageBreak", kind: "page" },
      { type: "paragraph", children: [{ type: "text", value: "本文の後の行" }] },
    ]);
    expect(doc.blocks.some((b) => b.type === "rawAnnotation")).toBe(false);
  });

  it("a same-line 大見出し and a 改ページ are both recognized with no blank lines anywhere (the reported bug's exact first sample)", () => {
    const doc = parseAozoraDocument(
      ["［＃改ページ］", "はじめに［＃「はじめに」は大見出し］", "　「時間の哲学」について、みなさんはどのような印象をお持ちでしょうか。"].join("\n"),
    );
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "pageBreak", kind: "page" },
      { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "はじめに" }] },
      {
        type: "paragraph",
        children: [{ type: "text", value: "　「時間の哲学」について、みなさんはどのような印象をお持ちでしょうか。" }],
      },
    ]);
    expect(doc.diagnostics).toEqual([]);
  });

  it("a ここから／ここで 見出しレンジ spanning several lines, with no blank lines anywhere, is recognized as one heading block (the reported bug's exact second sample)", () => {
    const doc = parseAozoraDocument(
      [
        "　さあ、ここから時間哲学を始めるのは、あなたです。",
        "［＃改ページ］",
        "［＃ここから大見出し］",
        "第Ⅰ部",
        "概念のツールボックス",
        "――考えるための道具を揃える――",
        "［＃ここで大見出し終わり］",
        "平井靖史",
        "［＃改ページ］",
      ].join("\n"),
    );

    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "pageBreak", "heading", "paragraph", "pageBreak"]);
    expect(doc.blocks.some((b) => b.type === "rawAnnotation")).toBe(false);
    // Note: "ここから時間哲学を始める" in the first line is plain Japanese
    // prose (no "［＃" prefix) and must never be mistaken for a range
    // marker — it stays literal, ordinary paragraph text.
    expect(textOf((doc.blocks[0] as { children: unknown }).children)).toContain("ここから時間哲学を始める");
    expect((doc.blocks[1] as { kind: string }).kind).toBe("page");
    const heading = doc.blocks[2] as { type: "heading"; level: number; variant: string; children: unknown };
    expect(heading.level).toBe(1);
    expect(heading.variant).toBe("normal");
    const headingText = textOf(heading.children);
    expect(headingText).toContain("第Ⅰ部");
    expect(headingText).toContain("概念のツールボックス");
    expect(headingText).toContain("――考えるための道具を揃える――");
    expect(textOf((doc.blocks[3] as { children: unknown }).children)).toContain("平井靖史");
    expect((doc.blocks[4] as { kind: string }).kind).toBe("page");
  });

  it("字下げ (single) with no blank line before it still applies only to the following glued paragraph", () => {
    const doc = parseAozoraDocument(["文1", "［＃3字下げ］", "文2", "文3"].join("\n"));
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", children: [{ type: "text", value: "文1" }] },
      { type: "paragraph", indentEm: 3, children: [{ type: "text", value: "文2\n文3" }] },
    ]);
  });

  it("中央寄せ ここから／ここで range with no blank lines still tags every paragraph inside it", () => {
    const doc = parseAozoraDocument(
      ["［＃ここから中央寄せ］", "中央1", "中央2", "［＃ここで中央寄せ終わり］", "通常"].join("\n"),
    );
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", align: "center", children: [{ type: "text", value: "中央1\n中央2" }] },
      { type: "paragraph", children: [{ type: "text", value: "通常" }] },
    ]);
  });

  it("a lone 見出し-range end marker (no matching start anywhere) fails soft as a raw annotation block, keeping the body", () => {
    const doc = parseAozoraDocument("［＃ここで大見出し終わり］\n\n本文");
    expect(doc.blocks.some((b) => b.type === "rawAnnotation")).toBe(true);
    expect(doc.blocks.some((b) => b.type === "paragraph")).toBe(true);
    expect(doc.diagnostics.some((d) => d.kind === "unmatched-end")).toBe(true);
  });

  it("a 見出し-range start marker that's never closed keeps the body content visible and diagnoses unclosed-range", () => {
    const doc = parseAozoraDocument("［＃ここから大見出し］\n\n本文1\n\n本文2");
    expect(doc.blocks.every((b) => b.type !== "heading")).toBe(true);
    expect(doc.blocks.some((b) => b.type === "rawAnnotation")).toBe(false);
    const allText = doc.blocks
      .filter((b): b is Extract<AozoraBlock, { type: "paragraph" }> => b.type === "paragraph")
      .map((b) => textOf(b.children))
      .join("");
    expect(allText).toContain("本文1");
    expect(allText).toContain("本文2");
    expect(doc.diagnostics.some((d) => d.kind === "unclosed-range")).toBe(true);
  });

  it("mismatched level/variant between a 見出し-range start and end falls back to a paragraph, not a heading, with fail-soft diagnostics", () => {
    const doc = parseAozoraDocument("［＃ここから大見出し］見出し文［＃ここで中見出し終わり］");
    expect(doc.blocks.every((b) => b.type !== "heading")).toBe(true);
    expect(doc.blocks.some((b) => b.type === "paragraph")).toBe(true);
    expect(doc.diagnostics.some((d) => d.kind === "unmatched-end")).toBe(true);
    expect(doc.diagnostics.some((d) => d.kind === "unclosed-range")).toBe(true);
  });

  describe("a 見出し-range that never finds its own ここで…見出し終わり is truncated at the next block control annotation, not left open until EOF or a distant unrelated end marker", () => {
    it("a 改ページ immediately after an unclosed ここから見出し is still a real pageBreak block, not swallowed as heading content", () => {
      const doc = parseAozoraDocument(["［＃ここから大見出し］", "［＃改ページ］", "本文"].join("\n"));
      expect(doc.blocks.every((b) => b.type !== "heading")).toBe(true);
      expect(doc.blocks.some((b) => b.type === "pageBreak" && b.kind === "page")).toBe(true);
      expect(doc.diagnostics.some((d) => d.kind === "unclosed-range")).toBe(true);
    });

    it("a 字下げ range start inside an unclosed ここから見出し is still recognized as a real indent directive, and the heading start marker survives as fail-soft literal text", () => {
      const doc = parseAozoraDocument(
        ["［＃ここから大見出し］", "見出しらしき文", "［＃ここから3字下げ］", "字下げされた本文", "［＃ここで字下げ終わり］"].join("\n"),
      );
      expect(doc.blocks.every((b) => b.type !== "heading")).toBe(true);
      expect(
        doc.blocks.some((b) => b.type === "paragraph" && b.indentEm === 3 && textOf(b.children).includes("字下げされた本文")),
      ).toBe(true);
      expect(doc.diagnostics.some((d) => d.kind === "unclosed-range")).toBe(true);
    });

    it("does not falsely truncate when the range legitimately closes before any control annotation appears", () => {
      const doc = parseAozoraDocument(
        ["文の前", "［＃ここから大見出し］", "見出しの内容", "［＃ここで大見出し終わり］", "［＃改ページ］"].join("\n"),
      );
      expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "pageBreak"]);
      expect(textOf((doc.blocks[0] as { children: unknown }).children)).toContain("文の前");
      const heading = doc.blocks[1] as { level: number; variant: string; children: unknown };
      expect(heading.level).toBe(1);
      expect(heading.variant).toBe("normal");
      expect(textOf(heading.children)).toContain("見出しの内容");
      expect((doc.blocks[2] as { kind: string }).kind).toBe("page");
      expect(doc.diagnostics).toEqual([]);
    });
  });
});

describe("罫囲み (ruled-box range, spec §9 — frame only, no table-column inference)", () => {
  function textOf(children: unknown): string {
    return (children as { type: string; value?: string }[])
      .map((c) => (c.type === "text" ? (c.value ?? "") : ""))
      .join("");
  }

  it("a ここから／ここで range tags every paragraph inside it with boxed:true, and none outside it", () => {
    const doc = parseAozoraDocument(
      "［＃ここから罫囲み］\n\n枠内1\n\n枠内2\n\n［＃ここで罫囲み終わり］\n\n枠外",
    );
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", boxed: true, children: [{ type: "text", value: "枠内1" }] },
      { type: "paragraph", boxed: true, children: [{ type: "text", value: "枠内2" }] },
      { type: "paragraph", children: [{ type: "text", value: "枠外" }] },
    ]);
  });

  it("recognizes the range with no blank lines anywhere (the line-unit boundary fix's benefit applies here too)", () => {
    const doc = parseAozoraDocument(
      [
        "本文では「未来志向の時間評価」という語を、次の2つに明確に分割し混同を避ける。",
        "［＃ここから罫囲み］",
        "区分　評価される時間　典型課題",
        "（A）経過型　持続の実時間　時間再生",
        "（B）予測型　志向的未来　見積もり",
        "［＃ここで罫囲み終わり］",
        "経過型は〈持続する時間の長さ〉をモニターする行為である。",
      ].join("\n"),
    );
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    const boxed = doc.blocks.filter((b) => b.type === "paragraph" && b.boxed === true);
    expect(boxed.length).toBeGreaterThan(0);
    expect(boxed.every((b) => b.type === "paragraph" && b.boxed === true)).toBe(true);
    const boxedText = boxed.map((b) => (b.type === "paragraph" ? textOf(b.children) : "")).join("\n");
    expect(boxedText).toContain("区分");
    expect(boxedText).toContain("経過型");
    expect(boxedText).toContain("予測型");
    const before = doc.blocks[0];
    expect(before.type).toBe("paragraph");
    expect(before.type === "paragraph" && before.boxed).toBeUndefined();
    const after = doc.blocks[doc.blocks.length - 1];
    expect(after.type).toBe("paragraph");
    expect(after.type === "paragraph" && after.boxed).toBeUndefined();
    expect(after.type === "paragraph" && textOf(after.children)).toContain("経過型は〈持続する時間の長さ〉");
    expect(doc.diagnostics.every((d) => d.kind !== "unclosed-range")).toBe(true);
  });

  it("composes with 字下げ／中央寄せ nesting: a paragraph can be boxed AND indented/centered at once", () => {
    const doc = parseAozoraDocument(
      "［＃ここから罫囲み］\n\n［＃ここから中央寄せ］\n\n中央かつ枠\n\n［＃ここで中央寄せ終わり］\n\n［＃ここで罫囲み終わり］",
    );
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", boxed: true, align: "center", children: [{ type: "text", value: "中央かつ枠" }] },
    ]);
  });

  it("a start-only range marker (never closed) still keeps the body content visible and diagnoses unclosed-range", () => {
    const doc = parseAozoraDocument("［＃ここから罫囲み］\n\n本文1\n\n本文2");
    const paragraphs = doc.blocks.filter((b): b is Extract<AozoraBlock, { type: "paragraph" }> => b.type === "paragraph");
    expect(paragraphs.map((p) => textOf(p.children))).toEqual(["本文1", "本文2"]);
    expect(doc.diagnostics.some((d) => d.kind === "unclosed-range" && d.annotationName === "罫囲み")).toBe(true);
  });

  it("an end-only range marker (no matching start) fails soft as a raw annotation block, keeping the body", () => {
    const doc = parseAozoraDocument("［＃ここで罫囲み終わり］\n\n本文");
    expect(doc.blocks.some((b) => b.type === "rawAnnotation")).toBe(true);
    expect(doc.blocks.some((b) => b.type === "paragraph")).toBe(true);
    expect(doc.diagnostics.some((d) => d.kind === "unmatched-end")).toBe(true);
  });

  it("shares MAX_RANGE_NESTING_DEPTH's budget with 字下げ／中央寄せ (spec §17)", () => {
    const opens = Array.from({ length: MAX_RANGE_NESTING_DEPTH + 10 }, (_, i) =>
      i % 2 === 0 ? "［＃ここから罫囲み］" : "［＃ここから中央寄せ］",
    ).join("\n\n");
    const closes = Array.from({ length: MAX_RANGE_NESTING_DEPTH + 10 }, (_, i) =>
      i % 2 === 0 ? "［＃ここで中央寄せ終わり］" : "［＃ここで罫囲み終わり］",
    ).join("\n\n");
    const doc = parseAozoraDocument(`${opens}\n\n本文\n\n${closes}`);
    expect(doc.diagnostics.some((d) => d.kind === "resource-limit")).toBe(true);
  });

  it("truncates a 見出しレンジ that swallows a stray ここから罫囲み just like it does for the other 9 control annotations", () => {
    const doc = parseAozoraDocument(["［＃ここから大見出し］", "［＃ここから罫囲み］", "本文"].join("\n"));
    expect(doc.blocks.every((b) => b.type !== "heading")).toBe(true);
    expect(doc.diagnostics.some((d) => d.kind === "unclosed-range")).toBe(true);
  });
});
