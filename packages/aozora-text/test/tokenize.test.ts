// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { splitIntoParagraphChunks, tokenizeAozoraChunk } from "../src/tokenize";

describe("splitIntoParagraphChunks", () => {
  it("splits on runs of 2+ newlines and reports each chunk's start line", () => {
    const chunks = splitIntoParagraphChunks("第一段落\n\n第二段落\n\n\n第三段落");
    expect(chunks.map((c) => c.text)).toEqual(["第一段落", "第二段落", "第三段落"]);
    expect(chunks.map((c) => c.startLine)).toEqual([1, 3, 6]);
  });

  it("keeps a single embedded newline inside one chunk", () => {
    const chunks = splitIntoParagraphChunks("一行目\n二行目");
    expect(chunks).toEqual([{ text: "一行目\n二行目", startLine: 1 }]);
  });

  it("never collapses more than the exact separator it split on (no data loss)", () => {
    const original = "a\n\nb\n\n\n\nc";
    const chunks = splitIntoParagraphChunks(original);
    expect(chunks.map((c) => c.text)).toEqual(["a", "b", "c"]);
  });
});

describe("tokenizeAozoraChunk", () => {
  it("yields a single text token for plain text", () => {
    expect(tokenizeAozoraChunk("ただの文章です。")).toEqual([
      { type: "text", value: "ただの文章です。" },
    ]);
  });

  it("recognizes an explicit ruby-base pipe marker", () => {
    expect(tokenizeAozoraChunk("｜")).toEqual([{ type: "pipe" }]);
  });

  it("recognizes a closed ruby reading", () => {
    expect(tokenizeAozoraChunk("漢字《かんじ》")).toEqual([
      { type: "text", value: "漢字" },
      { type: "ruby", reading: "かんじ", crossesNewline: false },
    ]);
  });

  it("flags a ruby reading that crosses a newline", () => {
    const tokens = tokenizeAozoraChunk("漢字《かん\nじ》");
    expect(tokens).toContainEqual({ type: "ruby", reading: "かん\nじ", crossesNewline: true });
  });

  it("terminates an unclosed ruby reading at EOF, consuming the rest verbatim", () => {
    expect(tokenizeAozoraChunk("漢字《読みかけ")).toEqual([
      { type: "text", value: "漢字" },
      { type: "unclosedRuby", raw: "《読みかけ" },
    ]);
  });

  it("recognizes a closed annotation", () => {
    expect(tokenizeAozoraChunk("本文［＃改ページ］続き")).toEqual([
      { type: "text", value: "本文" },
      { type: "annotation", body: "改ページ" },
      { type: "text", value: "続き" },
    ]);
  });

  it("terminates an unclosed annotation at EOF, consuming the rest verbatim", () => {
    expect(tokenizeAozoraChunk("本文［＃閉じない")).toEqual([
      { type: "text", value: "本文" },
      { type: "unclosedAnnotation", raw: "［＃閉じない" },
    ]);
  });

  it("treats a lone ［ (no ＃) as ordinary text", () => {
    expect(tokenizeAozoraChunk("配列は［1, 2, 3］です")).toEqual([
      { type: "text", value: "配列は［1, 2, 3］です" },
    ]);
  });

  it("treats a lone ］ (no matching ［＃) as ordinary text", () => {
    expect(tokenizeAozoraChunk("閉じ括弧］だけ")).toEqual([
      { type: "text", value: "閉じ括弧］だけ" },
    ]);
  });

  it("never produces a zero-width-consuming loop for a pathological run of delimiters", () => {
    const input = "｜".repeat(1000) + "《".repeat(1000);
    expect(() => tokenizeAozoraChunk(input)).not.toThrow();
  });

  it("scales roughly linearly for large inputs with many unclosed ［＃ (no catastrophic backtracking)", () => {
    const unit = "text［＃never closed ";
    const big = unit.repeat(80_000);
    const bigger = big + big;
    const t1 = performance.now();
    tokenizeAozoraChunk(big);
    const d1 = performance.now() - t1;
    const t2 = performance.now();
    tokenizeAozoraChunk(bigger);
    const d2 = performance.now() - t2;
    expect(d2).toBeLessThan(d1 * 8 + 100);
  });
});
