// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { parseAozoraDocument } from "../src/parse-document";
import {
  MAX_AST_NODES,
  MAX_ANNOTATION_CODEPOINTS,
  MAX_DIAGNOSTICS,
  MAX_RANGE_NESTING_DEPTH,
  MAX_RUBY_READING_CODEPOINTS,
} from "../src/types";
import type { AozoraBlock, AozoraDiagnostic, AozoraDocument, AozoraInline } from "../src/types";

describe("resource-limit constants (spec §17)", () => {
  it("match the spec's documented values", () => {
    expect(MAX_DIAGNOSTICS).toBe(200);
    expect(MAX_AST_NODES).toBe(1_000_000);
    expect(MAX_RANGE_NESTING_DEPTH).toBe(32);
    expect(MAX_ANNOTATION_CODEPOINTS).toBe(4096);
    expect(MAX_RUBY_READING_CODEPOINTS).toBe(256);
  });
});

describe("AozoraDocument shape (spec §7)", () => {
  it("parseAozoraDocument returns a document with all required top-level fields", () => {
    const doc: AozoraDocument = parseAozoraDocument("第一段落\n\n第二段落");
    expect(doc).toHaveProperty("blocks");
    expect(doc).toHaveProperty("bibliography");
    expect(doc).toHaveProperty("diagnostics");
    expect(Array.isArray(doc.blocks)).toBe(true);
    expect(Array.isArray(doc.bibliography)).toBe(true);
    expect(Array.isArray(doc.diagnostics)).toBe(true);
  });

  it("splits blank-line-separated text into separate paragraph blocks", () => {
    const doc = parseAozoraDocument("第一段落\n\n第二段落");
    expect(doc.blocks).toEqual<AozoraBlock[]>([
      { type: "paragraph", children: [{ type: "text", value: "第一段落" }] },
      { type: "paragraph", children: [{ type: "text", value: "第二段落" }] },
    ]);
  });

  it("drops whitespace-only chunks without producing an empty paragraph", () => {
    const doc = parseAozoraDocument("本文\n\n\n\n次の段落");
    expect(doc.blocks.length).toBe(2);
  });

  it("returns an empty diagnostics array for ordinary input", () => {
    const doc = parseAozoraDocument("普通の文章です。");
    expect(doc.diagnostics).toEqual([]);
  });
});

describe("AozoraInline / AozoraDiagnostic type shapes compile and hold expected literals", () => {
  it("accepts every emphasis style literal", () => {
    const styles: Array<Extract<AozoraInline, { type: "emphasis" }>["style"]> = [
      "sesame",
      "white-sesame",
      "black-circle",
      "white-circle",
      "black-triangle",
      "white-triangle",
      "bullseye",
      "fisheye",
      "saltire",
    ];
    expect(styles.length).toBe(9);
  });

  it("accepts every decoration style literal", () => {
    const styles: Array<Extract<AozoraInline, { type: "decoration" }>["style"]> = [
      "underline",
      "overline",
      "bold",
      "italic",
    ];
    expect(styles.length).toBe(4);
  });

  it("accepts a well-formed diagnostic", () => {
    const diagnostic: AozoraDiagnostic = {
      kind: "unsupported-annotation",
      severity: "warning",
      line: 1,
      column: 1,
      annotationName: "未対応注記",
    };
    expect(diagnostic.kind).toBe("unsupported-annotation");
  });
});
