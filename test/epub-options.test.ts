// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/base64url";
import {
  DEFAULT_EPUB_OPTIONS,
  decodeEpubOptionsHeader,
  validateEpubConvertOptions,
} from "../src/epub-options";

describe("validateEpubConvertOptions (spec §4.1.5)", () => {
  it("accepts the default options", () => {
    expect(validateEpubConvertOptions(DEFAULT_EPUB_OPTIONS)).toEqual({
      ok: true,
      options: DEFAULT_EPUB_OPTIONS,
    });
  });

  it("rejects a non-object value", () => {
    expect(validateEpubConvertOptions(null).ok).toBe(false);
    expect(validateEpubConvertOptions("x").ok).toBe(false);
    expect(validateEpubConvertOptions([]).ok).toBe(false);
  });

  it("rejects an invalid layout", () => {
    expect(
      validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, layout: "diagonal" }).ok,
    ).toBe(false);
  });

  it("accepts every valid layout", () => {
    for (const layout of ["auto", "horizontal", "vertical"]) {
      expect(
        validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, layout }).ok,
      ).toBe(true);
    }
  });

  it("rejects a font that fails sanitizeFontFamily", () => {
    expect(
      validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, font: "Evil</style>" }).ok,
    ).toBe(false);
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, font: "" }).ok).toBe(false);
  });

  it("enforces fontSizePx bounds (12-40, integer)", () => {
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, fontSizePx: 11 }).ok).toBe(false);
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, fontSizePx: 41 }).ok).toBe(false);
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, fontSizePx: 12.5 }).ok).toBe(false);
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, fontSizePx: 12 }).ok).toBe(true);
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, fontSizePx: 40 }).ok).toBe(true);
  });

  it("enforces marginPx bounds (0-120, integer)", () => {
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, marginPx: -1 }).ok).toBe(false);
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, marginPx: 121 }).ok).toBe(false);
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, marginPx: 0 }).ok).toBe(true);
    expect(validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, marginPx: 120 }).ok).toBe(true);
  });

  it("rejects a non-boolean chapterPageBreak/includeCover/includeTableOfContents", () => {
    expect(
      validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, chapterPageBreak: "yes" }).ok,
    ).toBe(false);
    expect(
      validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, includeCover: 1 }).ok,
    ).toBe(false);
    expect(
      validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, includeTableOfContents: null }).ok,
    ).toBe(false);
  });

  it("ignores unknown extra properties", () => {
    expect(
      validateEpubConvertOptions({ ...DEFAULT_EPUB_OPTIONS, extra: "ignored" }).ok,
    ).toBe(true);
  });
});

describe("decodeEpubOptionsHeader (spec §4.1.2)", () => {
  it("defaults to DEFAULT_EPUB_OPTIONS when the header is absent", () => {
    expect(decodeEpubOptionsHeader(null)).toEqual({ ok: true, options: DEFAULT_EPUB_OPTIONS });
  });

  it("decodes a valid base64url JSON payload", () => {
    const payload = { ...DEFAULT_EPUB_OPTIONS, layout: "vertical" as const };
    const header = encodeBase64Url(JSON.stringify(payload));
    expect(decodeEpubOptionsHeader(header)).toEqual({ ok: true, options: payload });
  });

  it("400s (via ok:false) on malformed base64url", () => {
    expect(decodeEpubOptionsHeader("not valid base64!").ok).toBe(false);
  });

  it("400s on valid base64url that isn't JSON", () => {
    const header = encodeBase64Url("not json");
    expect(decodeEpubOptionsHeader(header).ok).toBe(false);
  });

  it("400s on a well-formed but invalid options object (strict, not fail-soft — spec §4.1.5)", () => {
    const header = encodeBase64Url(JSON.stringify({ ...DEFAULT_EPUB_OPTIONS, fontSizePx: 999 }));
    expect(decodeEpubOptionsHeader(header)).toEqual({ ok: false, error: "invalid fontSizePx" });
  });
});
