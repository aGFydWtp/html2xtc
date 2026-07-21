// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  applyTextPreset,
  DEFAULT_TEXT_OPTIONS,
  encodeTextOptionsHeader,
  isUntouchedFromDefault,
  isValidFontFamily,
  isValidTextOptions,
  setTextLayout,
  TEXT_PRESETS,
  validateTextOptions,
  VERTICAL_DEFAULT_OVERRIDES,
  type TextConvertOptions,
} from "../src/lib/text-options";

function cloneDefaults(): TextConvertOptions {
  return { ...DEFAULT_TEXT_OPTIONS, margins: { ...DEFAULT_TEXT_OPTIONS.margins } };
}

describe("DEFAULT_TEXT_OPTIONS", () => {
  it("matches the spec's default values (§6.2)", () => {
    expect(DEFAULT_TEXT_OPTIONS).toEqual({
      encoding: "auto",
      layout: "horizontal",
      font: "BIZ UDPGothic",
      fontSizePx: 18,
      lineHeight: 1.8,
      paragraphSpacingEm: 0.9,
      margins: { top: 36, right: 32, bottom: 40, left: 32 },
      textAlign: "start",
      maxConsecutiveBlankLines: 2,
      preserveSpaces: false,
      showPageNumbers: false,
      title: "",
      author: "",
    });
  });

  it("is valid", () => {
    expect(isValidTextOptions(cloneDefaults())).toBe(true);
  });
});

describe("validateTextOptions", () => {
  it("rejects fontSizePx outside 12-32", () => {
    const opts = { ...cloneDefaults(), fontSizePx: 11 };
    expect(validateTextOptions(opts).some((e) => e.field === "fontSizePx")).toBe(true);
    expect(isValidTextOptions({ ...cloneDefaults(), fontSizePx: 33 })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), fontSizePx: 12 })).toBe(true);
    expect(isValidTextOptions({ ...cloneDefaults(), fontSizePx: 32 })).toBe(true);
  });

  it("rejects lineHeight outside 1.2-2.5", () => {
    expect(isValidTextOptions({ ...cloneDefaults(), lineHeight: 1.1 })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), lineHeight: 2.6 })).toBe(false);
  });

  it("rejects paragraphSpacingEm outside 0-3", () => {
    expect(isValidTextOptions({ ...cloneDefaults(), paragraphSpacingEm: -0.1 })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), paragraphSpacingEm: 3.1 })).toBe(false);
  });

  it("rejects margins outside 0-120", () => {
    const opts = cloneDefaults();
    opts.margins.top = 121;
    expect(isValidTextOptions(opts)).toBe(false);
    const opts2 = cloneDefaults();
    opts2.margins.left = -1;
    expect(isValidTextOptions(opts2)).toBe(false);
  });

  it("rejects maxConsecutiveBlankLines outside integer 0-5", () => {
    expect(isValidTextOptions({ ...cloneDefaults(), maxConsecutiveBlankLines: -1 })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), maxConsecutiveBlankLines: 6 })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), maxConsecutiveBlankLines: 2.5 })).toBe(false);
  });

  it("rejects title/author over 100 chars", () => {
    expect(isValidTextOptions({ ...cloneDefaults(), title: "a".repeat(101) })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), author: "a".repeat(101) })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), title: "a".repeat(100) })).toBe(true);
  });

  it("counts title/author by code points, not UTF-16 code units (matches backend)", () => {
    // U+1F600 is a surrogate pair (2 UTF-16 units, 1 code point). 100 of them
    // must be accepted (100 code points) even though .length reports 200.
    const emoji100 = "\u{1F600}".repeat(100);
    expect(emoji100.length).toBe(200);
    expect(isValidTextOptions({ ...cloneDefaults(), title: emoji100 })).toBe(true);
    expect(isValidTextOptions({ ...cloneDefaults(), title: emoji100 + "\u{1F600}" })).toBe(false);
  });

  it("rejects an invalid font family", () => {
    expect(isValidTextOptions({ ...cloneDefaults(), font: "Not; Valid" })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), font: "" })).toBe(false);
  });

  it("rejects invalid encoding/layout/textAlign enums", () => {
    expect(isValidTextOptions({ ...cloneDefaults(), encoding: "sjis" as never })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), layout: "rtl" as never })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), textAlign: "center" as never })).toBe(false);
  });
});

describe("isValidFontFamily", () => {
  it("accepts alnum/space/hyphen names starting with alnum, up to 64 chars", () => {
    expect(isValidFontFamily("BIZ UDPGothic")).toBe(true);
    expect(isValidFontFamily("Noto Sans JP")).toBe(true);
    expect(isValidFontFamily("a".repeat(64))).toBe(true);
  });

  it("rejects names that are too long, empty, or contain disallowed characters", () => {
    expect(isValidFontFamily("a".repeat(65))).toBe(false);
    expect(isValidFontFamily("")).toBe(false);
    expect(isValidFontFamily(" LeadingSpace")).toBe(false);
    expect(isValidFontFamily("Evil;DROP")).toBe(false);
    expect(isValidFontFamily("日本語フォント")).toBe(false);
  });
});

describe("TEXT_PRESETS / applyTextPreset (§6.5)", () => {
  it("standard preset matches spec", () => {
    expect(TEXT_PRESETS.standard).toEqual({ layout: "horizontal", font: "BIZ UDPGothic", fontSizePx: 18, lineHeight: 1.8 });
  });

  it("vertical_novel preset matches spec", () => {
    expect(TEXT_PRESETS.vertical_novel).toEqual({ layout: "vertical", font: "BIZ UDMincho", fontSizePx: 18, lineHeight: 1.9 });
  });

  it("large_font preset matches spec", () => {
    expect(TEXT_PRESETS.large_font).toEqual({ fontSizePx: 23, lineHeight: 1.8 });
  });

  it("applyTextPreset merges the preset onto existing options without touching other fields", () => {
    const opts = { ...cloneDefaults(), title: "My Book" };
    const applied = applyTextPreset(opts, "large_font");
    expect(applied.fontSizePx).toBe(23);
    expect(applied.lineHeight).toBe(1.8);
    expect(applied.title).toBe("My Book"); // untouched field preserved
    expect(applied.layout).toBe("horizontal"); // untouched field preserved
  });
});

describe("isUntouchedFromDefault / setTextLayout (§6.3)", () => {
  it("is true for a freshly cloned default", () => {
    expect(isUntouchedFromDefault(cloneDefaults())).toBe(true);
  });

  it("is false once a settable field diverges from default", () => {
    expect(isUntouchedFromDefault({ ...cloneDefaults(), fontSizePx: 20 })).toBe(false);
    const withMargin = cloneDefaults();
    withMargin.margins.top = 40;
    expect(isUntouchedFromDefault(withMargin)).toBe(false);
  });

  it("applies §6.3 vertical overrides when switching to vertical from an untouched default", () => {
    const result = setTextLayout(cloneDefaults(), "vertical");
    expect(result.layout).toBe("vertical");
    expect(result.font).toBe(VERTICAL_DEFAULT_OVERRIDES.font);
    expect(result.fontSizePx).toBe(VERTICAL_DEFAULT_OVERRIDES.fontSizePx);
    expect(result.lineHeight).toBe(VERTICAL_DEFAULT_OVERRIDES.lineHeight);
  });

  it("does NOT apply overrides when the user already changed a setting", () => {
    const touched = { ...cloneDefaults(), fontSizePx: 22 };
    const result = setTextLayout(touched, "vertical");
    expect(result.layout).toBe("vertical");
    expect(result.fontSizePx).toBe(22); // untouched: user's explicit choice preserved
    expect(result.font).toBe(DEFAULT_TEXT_OPTIONS.font); // not overridden to BIZ UDMincho
  });

  it("switching back to horizontal does not reapply any override", () => {
    const vertical = setTextLayout(cloneDefaults(), "vertical");
    const back = setTextLayout(vertical, "horizontal");
    expect(back.layout).toBe("horizontal");
    expect(back.font).toBe(VERTICAL_DEFAULT_OVERRIDES.font); // stays as-is; no reset defined by spec
  });
});

describe("encodeTextOptionsHeader", () => {
  it("round-trips through base64url(UTF-8) JSON decoding", () => {
    const opts = { ...cloneDefaults(), title: "日本語タイトル", author: "著者名" };
    const header = encodeTextOptionsHeader(opts);
    // base64url: no +, /, or = padding
    expect(header).not.toMatch(/[+/=]/);
    const binary = atob(header.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as TextConvertOptions;
    expect(decoded).toEqual(opts);
  });
});
