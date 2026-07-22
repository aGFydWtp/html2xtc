// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { AozoraAstLimitExceededError, parseAozoraDocument } from "../src/parse-document";
import type { AozoraBlock } from "../src/types";
import { MAX_DIAGNOSTICS } from "../src/types";

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
