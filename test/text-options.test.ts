// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/base64url";
import {
  DEFAULT_TEXT_OPTIONS,
  decodeTextOptionsHeader,
  validateTextConvertOptions,
} from "../src/text-options";

describe("validateTextConvertOptions", () => {
  it("accepts the default options", () => {
    const result = validateTextConvertOptions(DEFAULT_TEXT_OPTIONS);
    expect(result).toEqual({ ok: true, options: DEFAULT_TEXT_OPTIONS });
  });

  it("rejects a non-object value", () => {
    expect(validateTextConvertOptions(null)).toEqual({
      ok: false,
      error: "text options must be a JSON object",
    });
    expect(validateTextConvertOptions("x").ok).toBe(false);
    expect(validateTextConvertOptions([]).ok).toBe(false);
  });

  it("rejects an invalid encoding", () => {
    const result = validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, encoding: "utf-16" });
    expect(result).toEqual({ ok: false, error: "invalid encoding" });
  });

  it("rejects an invalid layout", () => {
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, layout: "diagonal" }).ok,
    ).toBe(false);
  });

  it("rejects a font that fails sanitizeFontFamily", () => {
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, font: "Evil</style>" }).ok,
    ).toBe(false);
    expect(validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, font: "" }).ok).toBe(false);
  });

  it("enforces fontSizePx bounds (12-32)", () => {
    expect(validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, fontSizePx: 11 }).ok).toBe(
      false,
    );
    expect(validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, fontSizePx: 33 }).ok).toBe(
      false,
    );
    expect(validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, fontSizePx: 12 }).ok).toBe(
      true,
    );
    expect(validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, fontSizePx: 32 }).ok).toBe(
      true,
    );
  });

  it("enforces lineHeight bounds (1.2-2.5)", () => {
    expect(validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, lineHeight: 1.1 }).ok).toBe(
      false,
    );
    expect(validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, lineHeight: 2.6 }).ok).toBe(
      false,
    );
  });

  it("enforces paragraphSpacingEm bounds (0-3)", () => {
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, paragraphSpacingEm: -0.1 }).ok,
    ).toBe(false);
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, paragraphSpacingEm: 3.1 }).ok,
    ).toBe(false);
  });

  it("validates each margin side independently (0-120)", () => {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      expect(
        validateTextConvertOptions({
          ...DEFAULT_TEXT_OPTIONS,
          margins: { ...DEFAULT_TEXT_OPTIONS.margins, [side]: 121 },
        }).ok,
      ).toBe(false);
      expect(
        validateTextConvertOptions({
          ...DEFAULT_TEXT_OPTIONS,
          margins: { ...DEFAULT_TEXT_OPTIONS.margins, [side]: -1 },
        }).ok,
      ).toBe(false);
    }
    expect(
      validateTextConvertOptions({
        ...DEFAULT_TEXT_OPTIONS,
        margins: { top: 0, right: 120, bottom: 0, left: 120 },
      }).ok,
    ).toBe(true);
  });

  it("rejects a non-object margins", () => {
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, margins: null }).ok,
    ).toBe(false);
  });

  it("rejects an invalid textAlign", () => {
    expect(validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, textAlign: "center" }).ok).toBe(
      false,
    );
  });

  it("enforces maxConsecutiveBlankLines as an integer 0-5", () => {
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, maxConsecutiveBlankLines: -1 }).ok,
    ).toBe(false);
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, maxConsecutiveBlankLines: 6 }).ok,
    ).toBe(false);
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, maxConsecutiveBlankLines: 2.5 }).ok,
    ).toBe(false);
  });

  it("requires preserveSpaces/showPageNumbers to be booleans", () => {
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, preserveSpaces: "yes" }).ok,
    ).toBe(false);
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, showPageNumbers: 1 }).ok,
    ).toBe(false);
  });

  it("caps title/author at 100 code points without implicit truncation", () => {
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, title: "a".repeat(100) }).ok,
    ).toBe(true);
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, title: "a".repeat(101) }),
    ).toEqual({ ok: false, error: "invalid title" });
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, author: "a".repeat(101) }),
    ).toEqual({ ok: false, error: "invalid author" });
  });

  it("ignores unknown extra properties", () => {
    expect(
      validateTextConvertOptions({ ...DEFAULT_TEXT_OPTIONS, extra: "ignored" }).ok,
    ).toBe(true);
  });
});

describe("decodeTextOptionsHeader", () => {
  it("falls back to DEFAULT_TEXT_OPTIONS when the header is absent", () => {
    expect(decodeTextOptionsHeader(null)).toEqual({ ok: true, options: DEFAULT_TEXT_OPTIONS });
  });

  it("decodes and validates a base64url JSON payload", () => {
    const custom = { ...DEFAULT_TEXT_OPTIONS, layout: "vertical" as const };
    const header = encodeBase64Url(JSON.stringify(custom));
    expect(decodeTextOptionsHeader(header)).toEqual({ ok: true, options: custom });
  });

  it("400s on malformed base64url", () => {
    const result = decodeTextOptionsHeader("not valid base64url!!");
    expect(result.ok).toBe(false);
  });

  it("400s on valid base64url that is not JSON", () => {
    const result = decodeTextOptionsHeader(encodeBase64Url("not json"));
    expect(result.ok).toBe(false);
  });

  it("400s on JSON that fails schema validation", () => {
    const result = decodeTextOptionsHeader(
      encodeBase64Url(JSON.stringify({ ...DEFAULT_TEXT_OPTIONS, fontSizePx: 999 })),
    );
    expect(result).toEqual({ ok: false, error: "invalid fontSizePx" });
  });
});
