// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EPUB_OPTIONS,
  encodeEpubOptionsHeader,
  type EpubConvertOptions,
  FONT_SIZE_PX_MAX,
  FONT_SIZE_PX_MIN,
  isValidEpubOptions,
  MARGIN_PX_MAX,
  MARGIN_PX_MIN,
  validateEpubOptions,
} from "../src/lib/epub-options";
import { encodeBase64UrlUtf8 } from "../src/lib/pdf-options";

function withOverrides(overrides: Partial<EpubConvertOptions>): EpubConvertOptions {
  return { ...DEFAULT_EPUB_OPTIONS, ...overrides };
}

describe("validateEpubOptions", () => {
  it("accepts the default options", () => {
    expect(validateEpubOptions(DEFAULT_EPUB_OPTIONS)).toEqual([]);
    expect(isValidEpubOptions(DEFAULT_EPUB_OPTIONS)).toBe(true);
  });

  it("accepts every layout value", () => {
    expect(validateEpubOptions(withOverrides({ layout: "auto" }))).toEqual([]);
    expect(validateEpubOptions(withOverrides({ layout: "horizontal" }))).toEqual([]);
    expect(validateEpubOptions(withOverrides({ layout: "vertical" }))).toEqual([]);
  });

  it("rejects an invalid layout", () => {
    // @ts-expect-error intentionally invalid for the test
    expect(validateEpubOptions(withOverrides({ layout: "sideways" })).some((e) => e.field === "layout")).toBe(true);
  });

  it("rejects an invalid font family", () => {
    expect(validateEpubOptions(withOverrides({ font: "" })).some((e) => e.field === "font")).toBe(true);
    expect(validateEpubOptions(withOverrides({ font: "invalid;font" })).some((e) => e.field === "font")).toBe(true);
  });

  it("accepts fontSizePx boundary values", () => {
    expect(validateEpubOptions(withOverrides({ fontSizePx: FONT_SIZE_PX_MIN }))).toEqual([]);
    expect(validateEpubOptions(withOverrides({ fontSizePx: FONT_SIZE_PX_MAX }))).toEqual([]);
  });

  it("rejects fontSizePx out of range or non-integer", () => {
    expect(validateEpubOptions(withOverrides({ fontSizePx: FONT_SIZE_PX_MIN - 1 })).length).toBeGreaterThan(0);
    expect(validateEpubOptions(withOverrides({ fontSizePx: FONT_SIZE_PX_MAX + 1 })).length).toBeGreaterThan(0);
    expect(validateEpubOptions(withOverrides({ fontSizePx: 22.5 })).length).toBeGreaterThan(0);
  });

  it("accepts marginPx boundary values", () => {
    expect(validateEpubOptions(withOverrides({ marginPx: MARGIN_PX_MIN }))).toEqual([]);
    expect(validateEpubOptions(withOverrides({ marginPx: MARGIN_PX_MAX }))).toEqual([]);
  });

  it("rejects marginPx out of range or non-integer", () => {
    expect(validateEpubOptions(withOverrides({ marginPx: MARGIN_PX_MIN - 1 })).length).toBeGreaterThan(0);
    expect(validateEpubOptions(withOverrides({ marginPx: MARGIN_PX_MAX + 1 })).length).toBeGreaterThan(0);
    expect(validateEpubOptions(withOverrides({ marginPx: 48.5 })).length).toBeGreaterThan(0);
  });

  it("rejects non-boolean flags", () => {
    // @ts-expect-error intentionally invalid for the test
    expect(validateEpubOptions(withOverrides({ chapterPageBreak: "yes" })).some((e) => e.field === "chapterPageBreak")).toBe(true);
    // @ts-expect-error intentionally invalid for the test
    expect(validateEpubOptions(withOverrides({ includeCover: 1 })).some((e) => e.field === "includeCover")).toBe(true);
    // @ts-expect-error intentionally invalid for the test
    expect(validateEpubOptions(withOverrides({ includeTableOfContents: null })).some((e) => e.field === "includeTableOfContents")).toBe(true);
  });
});

describe("encodeEpubOptionsHeader", () => {
  it("encodes EpubConvertOptions as base64url JSON", () => {
    const encoded = encodeEpubOptionsHeader(DEFAULT_EPUB_OPTIONS);
    expect(encoded).not.toMatch(/[+/=]/);
    const json = decodeURIComponent(
      atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    expect(JSON.parse(json)).toEqual(DEFAULT_EPUB_OPTIONS);
  });

  it("matches the shared base64url(UTF-8) encoder used by PDF/TXT", () => {
    expect(encodeEpubOptionsHeader(DEFAULT_EPUB_OPTIONS)).toBe(encodeBase64UrlUtf8(JSON.stringify(DEFAULT_EPUB_OPTIONS)));
  });
});
