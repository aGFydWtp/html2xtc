// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  AOZORA_PRESET_OVERRIDES,
  applyAozoraPresetIfUntouched,
  applyTextPreset,
  DEFAULT_TEXT_OPTIONS,
  defaultFontForLang,
  defaultTextOptionsForLang,
  encodeTextOptionsHeader,
  fontCandidatesForLang,
  FONT_CANDIDATES,
  isJoinHardWrappedLinesEditable,
  isMarkdownFileName,
  isMaxConsecutiveBlankLinesEditable,
  isPreserveSpacesEditable,
  isUntouchedForAozoraPreset,
  isUntouchedFromDefault,
  isValidFontFamily,
  isValidTextOptions,
  setTextLayout,
  textPresetsForLang,
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
      inputFormat: "plain",
      encoding: "auto",
      layout: "horizontal",
      font: "BIZ UDPGothic",
      fontSizePx: 26,
      lineHeight: 1.8,
      paragraphSpacingEm: 0.9,
      margins: { top: 36, right: 32, bottom: 40, left: 32 },
      textAlign: "start",
      maxConsecutiveBlankLines: 2,
      preserveSpaces: false,
      joinHardWrappedLines: true,
      showPageNumbers: false,
      title: "",
      author: "",
      device: "x3",
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

  it("accepts markdown as inputFormat and rejects unknown inputFormat values (Markdown対応仕様書 §22.1)", () => {
    expect(isValidTextOptions({ ...cloneDefaults(), inputFormat: "markdown" })).toBe(true);
    expect(isValidTextOptions({ ...cloneDefaults(), inputFormat: "md" as never })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), inputFormat: "commonmark" as never })).toBe(false);
  });

  it("rejects invalid encoding/layout/textAlign enums", () => {
    expect(isValidTextOptions({ ...cloneDefaults(), encoding: "sjis" as never })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), layout: "rtl" as never })).toBe(false);
    expect(isValidTextOptions({ ...cloneDefaults(), textAlign: "center" as never })).toBe(false);
  });

  it("requires joinHardWrappedLines to be boolean", () => {
    expect(
      validateTextOptions({ ...cloneDefaults(), joinHardWrappedLines: "yes" as never }).some(
        (e) => e.field === "joinHardWrappedLines",
      ),
    ).toBe(true);
    expect(isValidTextOptions({ ...cloneDefaults(), joinHardWrappedLines: false })).toBe(true);
    expect(isValidTextOptions({ ...cloneDefaults(), joinHardWrappedLines: true })).toBe(true);
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

describe("textPresetsForLang / applyTextPreset (§6.5)", () => {
  it("ja: standard preset matches spec (existing default font)", () => {
    expect(textPresetsForLang("ja").standard).toEqual({ layout: "horizontal", font: "BIZ UDPGothic", fontSizePx: 26, lineHeight: 1.8 });
  });

  it("en: standard preset uses the English UI default font, not the Japanese one", () => {
    expect(textPresetsForLang("en").standard).toEqual({ layout: "horizontal", font: "Literata", fontSizePx: 26, lineHeight: 1.8 });
  });

  it("vertical_novel preset matches spec regardless of UI language (vertical writing is Japanese-only)", () => {
    expect(textPresetsForLang("ja").vertical_novel).toEqual({ layout: "vertical", font: "BIZ UDMincho", fontSizePx: 26, lineHeight: 1.9 });
    expect(textPresetsForLang("en").vertical_novel).toEqual({ layout: "vertical", font: "BIZ UDMincho", fontSizePx: 26, lineHeight: 1.9 });
  });

  it("large_font preset has no font (not language-dependent)", () => {
    expect(textPresetsForLang("ja").large_font).toEqual({ fontSizePx: 30, lineHeight: 1.8 });
    expect(textPresetsForLang("en").large_font).toEqual({ fontSizePx: 30, lineHeight: 1.8 });
  });

  it("applyTextPreset merges the preset onto existing options without touching other fields", () => {
    const opts = { ...cloneDefaults(), title: "My Book" };
    const applied = applyTextPreset(opts, "large_font", "ja");
    expect(applied.fontSizePx).toBe(30);
    expect(applied.lineHeight).toBe(1.8);
    expect(applied.title).toBe("My Book"); // untouched field preserved
    expect(applied.layout).toBe("horizontal"); // untouched field preserved
  });

  it("applyTextPreset('standard') picks the font for the given language", () => {
    expect(applyTextPreset(cloneDefaults(), "standard", "ja").font).toBe("BIZ UDPGothic");
    expect(applyTextPreset(cloneDefaults(), "standard", "en").font).toBe("Literata");
  });
});

describe("defaultFontForLang / defaultTextOptionsForLang / fontCandidatesForLang (frontend-only, per UI language)", () => {
  it("ja stays on the existing default font (BIZ UDPGothic)", () => {
    expect(defaultFontForLang("ja")).toBe("BIZ UDPGothic");
  });

  it("en (and any non-ja language) falls back to Literata", () => {
    expect(defaultFontForLang("en")).toBe("Literata");
  });

  it("defaultTextOptionsForLang only differs from DEFAULT_TEXT_OPTIONS in font", () => {
    const ja = defaultTextOptionsForLang("ja");
    expect(ja).toEqual(DEFAULT_TEXT_OPTIONS);
    const en = defaultTextOptionsForLang("en");
    expect(en).toEqual({ ...DEFAULT_TEXT_OPTIONS, font: "Literata" });
  });

  it("fontCandidatesForLang('ja') keeps the existing order (Japanese fonts first)", () => {
    const candidates = fontCandidatesForLang("ja");
    expect(candidates).toEqual(FONT_CANDIDATES);
    expect(candidates[0].family).toBe("BIZ UDGothic");
  });

  it("fontCandidatesForLang('en') puts the English fonts first, without dropping any candidate", () => {
    const candidates = fontCandidatesForLang("en");
    expect(candidates[0].family).toBe("Literata");
    expect(candidates.slice(0, 4).map((c) => c.family)).toEqual(["Literata", "Merriweather", "EB Garamond", "Inter"]);
    // 除外はしない — 両言語で全12書体が選べる（並び順のみが変わる）。
    expect(candidates).toHaveLength(FONT_CANDIDATES.length);
    expect(new Set(candidates.map((c) => c.family))).toEqual(new Set(FONT_CANDIDATES.map((c) => c.family)));
  });
});

describe("isUntouchedFromDefault / setTextLayout (§6.3)", () => {
  const jaBaseline = cloneDefaults();

  it("is true for a freshly cloned default", () => {
    expect(isUntouchedFromDefault(cloneDefaults(), jaBaseline)).toBe(true);
  });

  it("is false once a settable field diverges from default", () => {
    expect(isUntouchedFromDefault({ ...cloneDefaults(), fontSizePx: 20 }, jaBaseline)).toBe(false);
    const withMargin = cloneDefaults();
    withMargin.margins.top = 40;
    expect(isUntouchedFromDefault(withMargin, jaBaseline)).toBe(false);
  });

  it("is false once joinHardWrappedLines diverges from default", () => {
    expect(isUntouchedFromDefault({ ...cloneDefaults(), joinHardWrappedLines: false }, jaBaseline)).toBe(false);
  });

  it("applies §6.3 vertical overrides when switching to vertical from an untouched default", () => {
    const result = setTextLayout(cloneDefaults(), "vertical", jaBaseline);
    expect(result.layout).toBe("vertical");
    expect(result.font).toBe(VERTICAL_DEFAULT_OVERRIDES.font);
    expect(result.fontSizePx).toBe(VERTICAL_DEFAULT_OVERRIDES.fontSizePx);
    expect(result.lineHeight).toBe(VERTICAL_DEFAULT_OVERRIDES.lineHeight);
  });

  it("does NOT apply overrides when the user already changed a setting", () => {
    const touched = { ...cloneDefaults(), fontSizePx: 22 };
    const result = setTextLayout(touched, "vertical", jaBaseline);
    expect(result.layout).toBe("vertical");
    expect(result.fontSizePx).toBe(22); // untouched: user's explicit choice preserved
    expect(result.font).toBe(DEFAULT_TEXT_OPTIONS.font); // not overridden to BIZ UDMincho
  });

  it("switching back to horizontal does not reapply any override", () => {
    const vertical = setTextLayout(cloneDefaults(), "vertical", jaBaseline);
    const back = setTextLayout(vertical, "horizontal", jaBaseline);
    expect(back.layout).toBe("horizontal");
    expect(back.font).toBe(VERTICAL_DEFAULT_OVERRIDES.font); // stays as-is; no reset defined by spec
  });

  // 回帰防止（英語UIの既定フォント導入時の要件）: 英語UI相当のbaselineから始めても、
  // 縦書き切替の判定基準はそのbaseline（font: "Literata"）と比較される。「未タッチ」
  // であれば、上書き先は VERTICAL_DEFAULT_OVERRIDES（BIZ UDMincho固定、言語非依存）
  // になる — 縦書きは日本語前提のため、UI言語に関わらずBIZ UDMinchoへ切り替わる。
  it("English-UI baseline: switching to vertical from an untouched English default still lands on BIZ UDMincho", () => {
    const enBaseline = defaultTextOptionsForLang("en");
    const enOptions = { ...enBaseline, margins: { ...enBaseline.margins } };
    expect(enOptions.font).toBe("Literata");
    const result = setTextLayout(enOptions, "vertical", enBaseline);
    expect(result.layout).toBe("vertical");
    expect(result.font).toBe("BIZ UDMincho");
  });
});

describe("isUntouchedForAozoraPreset / applyAozoraPresetIfUntouched (§15.3)", () => {
  const jaBaseline = cloneDefaults();

  it("matches the spec's aozora preset overrides", () => {
    expect(AOZORA_PRESET_OVERRIDES).toEqual({
      layout: "vertical",
      font: "BIZ UDMincho",
      fontSizePx: 26,
      lineHeight: 1.9,
      joinHardWrappedLines: false,
    });
  });

  it("is true for a freshly cloned default (layout/font/fontSizePx/lineHeight/joinHardWrappedLines all default)", () => {
    expect(isUntouchedForAozoraPreset(cloneDefaults(), jaBaseline)).toBe(true);
  });

  it("applies the aozora preset when every relevant field is still at its default", () => {
    const applied = applyAozoraPresetIfUntouched(cloneDefaults(), jaBaseline);
    expect(applied.layout).toBe("vertical");
    expect(applied.font).toBe("BIZ UDMincho");
    expect(applied.fontSizePx).toBe(26);
    expect(applied.lineHeight).toBe(1.9);
    expect(applied.joinHardWrappedLines).toBe(false);
  });

  it("does NOT apply the preset once the user has changed any of the five fields", () => {
    const touchedFontSize = applyAozoraPresetIfUntouched({ ...cloneDefaults(), fontSizePx: 22 }, jaBaseline);
    expect(touchedFontSize.fontSizePx).toBe(22);
    expect(touchedFontSize.layout).toBe("horizontal"); // no override applied at all, not just fontSizePx spared

    const touchedLayout = applyAozoraPresetIfUntouched({ ...cloneDefaults(), layout: "vertical" }, jaBaseline);
    expect(touchedLayout.font).toBe(DEFAULT_TEXT_OPTIONS.font); // still BIZ UDPGothic, not overridden

    const touchedJoin = applyAozoraPresetIfUntouched({ ...cloneDefaults(), joinHardWrappedLines: false }, jaBaseline);
    expect(touchedJoin.layout).toBe("horizontal");
  });

  it("preserves unrelated fields (title/author/margins) untouched", () => {
    const opts = { ...cloneDefaults(), title: "My Book", author: "Someone" };
    const applied = applyAozoraPresetIfUntouched(opts, jaBaseline);
    expect(applied.title).toBe("My Book");
    expect(applied.author).toBe("Someone");
    expect(applied.margins).toEqual(DEFAULT_TEXT_OPTIONS.margins);
  });

  // 回帰防止（英語UIの既定フォント導入時の要件）: 英語UI相当のbaseline
  // （font: "Literata"）から始めても、青空文庫プリセットは baseline との比較で
  // 「未タッチ」と判定され、AOZORA_PRESET_OVERRIDES（BIZ UDMincho固定、
  // 言語非依存）が適用される — 青空文庫はUI言語に関わらず現状の挙動を維持する。
  it("English-UI baseline: the aozora preset still applies and still lands on BIZ UDMincho", () => {
    const enBaseline = defaultTextOptionsForLang("en");
    const enOptions = { ...enBaseline, margins: { ...enBaseline.margins } };
    expect(enOptions.font).toBe("Literata");
    const applied = applyAozoraPresetIfUntouched(enOptions, enBaseline);
    expect(applied.layout).toBe("vertical");
    expect(applied.font).toBe("BIZ UDMincho");
    expect(applied.joinHardWrappedLines).toBe(false);
  });
});

describe("isJoinHardWrappedLinesEditable (§15.6, Markdown対応仕様書 §8)", () => {
  it("is false for aozora and markdown, true for plain", () => {
    expect(isJoinHardWrappedLinesEditable("aozora")).toBe(false);
    expect(isJoinHardWrappedLinesEditable("markdown")).toBe(false);
    expect(isJoinHardWrappedLinesEditable("plain")).toBe(true);
  });
});

describe("isMaxConsecutiveBlankLinesEditable / isPreserveSpacesEditable (Markdown対応仕様書 §8/§17.3)", () => {
  it("is false only for markdown — aozora keeps these two editable, unlike joinHardWrappedLines", () => {
    expect(isMaxConsecutiveBlankLinesEditable("markdown")).toBe(false);
    expect(isMaxConsecutiveBlankLinesEditable("aozora")).toBe(true);
    expect(isMaxConsecutiveBlankLinesEditable("plain")).toBe(true);

    expect(isPreserveSpacesEditable("markdown")).toBe(false);
    expect(isPreserveSpacesEditable("aozora")).toBe(true);
    expect(isPreserveSpacesEditable("plain")).toBe(true);
  });
});

describe("isMarkdownFileName (Markdown対応仕様書 §5.4/§17.4)", () => {
  it("matches .md and .markdown, case-insensitively", () => {
    expect(isMarkdownFileName("doc.md")).toBe(true);
    expect(isMarkdownFileName("doc.MD")).toBe(true);
    expect(isMarkdownFileName("doc.markdown")).toBe(true);
    expect(isMarkdownFileName("doc.MARKDOWN")).toBe(true);
  });

  it("does not match .txt or other extensions", () => {
    expect(isMarkdownFileName("doc.txt")).toBe(false);
    expect(isMarkdownFileName("doc.markdown.txt")).toBe(false);
    expect(isMarkdownFileName("doc")).toBe(false);
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
