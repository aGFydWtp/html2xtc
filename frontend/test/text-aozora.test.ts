// SPDX-License-Identifier: AGPL-3.0-or-later
// WebUI 青空文庫対応（aozora-text-conversion 仕様書 §15）の純粋関数群のテスト。
// Svelteコンポーネント（TextInputPanel.svelte/TextOptions.svelte）自体の単体テストは
// 行わず、そこから切り出したロジックをここで検証する（実装ブリーフのテスト方針）。
import { describe, expect, it } from "vitest";
import type { AozoraDiagnostic } from "@html2xtc/aozora-text";
import { DEFAULT_TEXT_OPTIONS, type TextConvertOptions } from "../src/lib/text-options";
import {
  computeInitialTextOptions,
  resolveAutoFillAuthor,
  resolveAutoFillTitle,
  resolveAutoInputFormat,
  summarizeAozoraDiagnostics,
} from "../src/lib/text-aozora";

function cloneDefaults(): TextConvertOptions {
  return { ...DEFAULT_TEXT_OPTIONS, margins: { ...DEFAULT_TEXT_OPTIONS.margins } };
}

// score: ［＃ が2回以上(+3) + 《...》 が存在(+2) = 5 → aozora（仕様 §15.2 の閾値表）。
const AOZORA_LOOKING_TEXT = `表題テスト
著者テスト
-------------------------------------------------------
本文［＃ここから2字下げ］
テスト［＃ここで字下げ終わり］
これは《ルビ》のテストです。
`;

// 単一の《…》だけ(+2)ではスコアが閾値(5)に届かない（仕様 §15.2「単一の《...》だけでは
// 自動判定しない」）。
const SINGLE_RUBY_ONLY_TEXT = "これは《ルビ》が一つだけあるだけの、ごく普通の文章です。";

const PLAIN_TEXT = "これはただのプレーンテキストです。何の注記もありません。";

describe("resolveAutoInputFormat (§15.2)", () => {
  it("selects aozora on high-confidence detection when not manually set", () => {
    expect(resolveAutoInputFormat("plain", false, { score: 5, isAozora: true })).toBe("aozora");
  });

  it("keeps the current format on low-confidence detection", () => {
    expect(resolveAutoInputFormat("plain", false, { score: 2, isAozora: false })).toBe("plain");
  });

  it("never overrides the format once the user has manually changed it, even at high confidence", () => {
    expect(resolveAutoInputFormat("plain", true, { score: 9, isAozora: true })).toBe("plain");
    expect(resolveAutoInputFormat("aozora", true, { score: 0, isAozora: false })).toBe("aozora");
  });
});

describe("computeInitialTextOptions (§15.2/§15.3)", () => {
  it("auto-selects aozora and applies its preset for high-confidence text when untouched", () => {
    const result = computeInitialTextOptions(cloneDefaults(), AOZORA_LOOKING_TEXT, false);
    expect(result.inputFormat).toBe("aozora");
    expect(result.layout).toBe("vertical");
    expect(result.font).toBe("BIZ UDMincho");
    expect(result.fontSizePx).toBe(18);
    expect(result.lineHeight).toBe(1.9);
    expect(result.joinHardWrappedLines).toBe(false);
  });

  it("does not auto-select aozora for a single lone 《...》 (§15.2)", () => {
    const result = computeInitialTextOptions(cloneDefaults(), SINGLE_RUBY_ONLY_TEXT, false);
    expect(result.inputFormat).toBe("plain");
  });

  it("applies the standard preset for plain text", () => {
    const result = computeInitialTextOptions(cloneDefaults(), PLAIN_TEXT, false);
    expect(result.inputFormat).toBe("plain");
    expect(result.layout).toBe("horizontal");
    expect(result.font).toBe("BIZ UDPGothic");
  });

  it("does not auto-select aozora once the user manually chose a format, even for high-confidence text", () => {
    const result = computeInitialTextOptions(cloneDefaults(), AOZORA_LOOKING_TEXT, true);
    expect(result.inputFormat).toBe("plain");
    // manuallySet だけで inputFormat は plain のまま。プリセットは今の形式(plain)の
    // ものが適用される。
    expect(result.layout).toBe("horizontal");
  });

  it("auto-selects the format but does NOT reapply the aozora preset once the user customized a preset field", () => {
    const customized = { ...cloneDefaults(), fontSizePx: 22 };
    const result = computeInitialTextOptions(customized, AOZORA_LOOKING_TEXT, false);
    expect(result.inputFormat).toBe("aozora"); // format selection is independent of preset gating
    expect(result.fontSizePx).toBe(22); // user's explicit choice preserved
    expect(result.layout).toBe("horizontal"); // preset not applied at all (not just fontSizePx spared)
  });
});

describe("resolveAutoFillTitle (§15.4)", () => {
  it("fills in the extracted title when the current title is empty", () => {
    expect(resolveAutoFillTitle("", "auto-derived.txt", "抽出された表題")).toBe("抽出された表題");
  });

  it("fills in the extracted title when the current title still equals the filename-derived value", () => {
    expect(resolveAutoFillTitle("auto-derived.txt", "auto-derived.txt", "抽出された表題")).toBe("抽出された表題");
  });

  it("does not overwrite a user-typed title", () => {
    expect(resolveAutoFillTitle("ユーザー入力の表題", "auto-derived.txt", "抽出された表題")).toBe("ユーザー入力の表題");
  });

  it("leaves the title untouched when no title could be extracted", () => {
    expect(resolveAutoFillTitle("", "auto-derived.txt", undefined)).toBe("");
    expect(resolveAutoFillTitle("", "auto-derived.txt", "   ")).toBe("");
  });

  it("truncates the extracted title to 100 code points", () => {
    const long = "あ".repeat(150);
    expect(resolveAutoFillTitle("", "auto-derived.txt", long)).toBe("あ".repeat(100));
  });
});

describe("resolveAutoFillAuthor (§15.4)", () => {
  it("fills in the extracted author when the field is empty", () => {
    expect(resolveAutoFillAuthor("", "抽出された著者")).toBe("抽出された著者");
  });

  it("does not overwrite a user-typed author", () => {
    expect(resolveAutoFillAuthor("ユーザー入力の著者", "抽出された著者")).toBe("ユーザー入力の著者");
  });

  it("leaves the author untouched when nothing could be extracted", () => {
    expect(resolveAutoFillAuthor("", undefined)).toBe("");
    expect(resolveAutoFillAuthor("", "   ")).toBe("");
  });
});

describe("summarizeAozoraDiagnostics (§15.5)", () => {
  it("returns all-zero, non-truncated for an empty diagnostics list", () => {
    expect(summarizeAozoraDiagnostics([])).toEqual({
      unsupportedAnnotations: 0,
      malformedAnnotations: 0,
      truncated: false,
    });
  });

  it("classifies unsupported-annotation separately from the other 'malformed' kinds", () => {
    const diagnostics: AozoraDiagnostic[] = [
      { kind: "unsupported-annotation", severity: "warning", line: 1, column: 0 },
      { kind: "unsupported-annotation", severity: "warning", line: 2, column: 0 },
      { kind: "malformed-annotation", severity: "warning", line: 3, column: 0 },
      { kind: "unmatched-end", severity: "warning", line: 4, column: 0 },
      { kind: "unclosed-range", severity: "warning", line: 5, column: 0 },
      { kind: "ruby-without-base", severity: "warning", line: 6, column: 0 },
      { kind: "resource-limit", severity: "error", line: 7, column: 0 },
    ];
    expect(summarizeAozoraDiagnostics(diagnostics)).toEqual({
      unsupportedAnnotations: 2,
      malformedAnnotations: 4,
      truncated: false,
    });
  });

  it("reports truncated once the diagnostics list reaches the shared MAX_DIAGNOSTICS cap", () => {
    const diagnostics: AozoraDiagnostic[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "unsupported-annotation" as const,
      severity: "warning" as const,
      line: i,
      column: 0,
    }));
    expect(summarizeAozoraDiagnostics(diagnostics).truncated).toBe(true);
    expect(summarizeAozoraDiagnostics(diagnostics.slice(0, 199)).truncated).toBe(false);
  });
});
