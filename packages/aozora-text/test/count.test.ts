// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { countRecognizedAnnotations } from "../src/count";
import type { AozoraDocument } from "../src/types";

function doc(overrides: Partial<AozoraDocument> = {}): AozoraDocument {
  return { blocks: [], bibliography: [], diagnostics: [], ...overrides };
}

describe("countRecognizedAnnotations", () => {
  it("counts a document with 2 ruby + 1 heading + 1 emphasis as 4", () => {
    const document = doc({
      blocks: [
        { type: "heading", level: 1, variant: "normal", children: [{ type: "text", value: "第一章" }] },
        {
          type: "paragraph",
          children: [
            { type: "ruby", base: [{ type: "text", value: "倫敦" }], reading: "ロンドン" },
            { type: "text", value: "に" },
            { type: "ruby", base: [{ type: "text", value: "住" }], reading: "す" },
            { type: "text", value: "んでいた。" },
            {
              type: "emphasis",
              style: "sesame",
              children: [{ type: "text", value: "強調" }],
            },
          ],
        },
      ],
    });
    expect(countRecognizedAnnotations(document)).toBe(4);
  });

  it("does not count rawAnnotation (inline or block)", () => {
    const document = doc({
      blocks: [
        { type: "rawAnnotation", text: "［＃未対応の注記］" },
        {
          type: "paragraph",
          children: [
            { type: "text", value: "本文" },
            { type: "rawAnnotation", text: "［＃インライン注記］" },
          ],
        },
      ],
    });
    expect(countRecognizedAnnotations(document)).toBe(0);
  });

  it("does not count plain text or an undecorated paragraph", () => {
    const document = doc({
      blocks: [{ type: "paragraph", children: [{ type: "text", value: "普通の文章です。" }] }],
    });
    expect(countRecognizedAnnotations(document)).toBe(0);
  });

  it("counts an indented or aligned paragraph once", () => {
    const document = doc({
      blocks: [
        { type: "paragraph", indentEm: 3, children: [{ type: "text", value: "字下げ" }] },
        { type: "paragraph", align: "center", children: [{ type: "text", value: "中央寄せ" }] },
        { type: "paragraph", align: "end", children: [{ type: "text", value: "地付き" }] },
      ],
    });
    expect(countRecognizedAnnotations(document)).toBe(3);
  });

  it("counts pageBreak blocks", () => {
    const document = doc({ blocks: [{ type: "pageBreak", kind: "page" }] });
    expect(countRecognizedAnnotations(document)).toBe(1);
  });

  it("recurses into nested children (decoration wrapping a ruby counts both)", () => {
    const document = doc({
      blocks: [
        {
          type: "paragraph",
          children: [
            {
              type: "decoration",
              style: "bold",
              children: [{ type: "ruby", base: [{ type: "text", value: "漢字" }], reading: "かんじ" }],
            },
          ],
        },
      ],
    });
    expect(countRecognizedAnnotations(document)).toBe(2);
  });

  it("counts tcy and gaiji nodes", () => {
    const document = doc({
      blocks: [
        {
          type: "paragraph",
          children: [
            { type: "tcy", children: [{ type: "text", value: "12" }] },
            { type: "gaiji", description: "土へん＋奇" },
          ],
        },
      ],
    });
    expect(countRecognizedAnnotations(document)).toBe(2);
  });

  it("counts recognized annotations inside the bibliography too", () => {
    const document = doc({
      bibliography: [{ type: "heading", level: 3, variant: "normal", children: [{ type: "text", value: "底本" }] }],
    });
    expect(countRecognizedAnnotations(document)).toBe(1);
  });
});
