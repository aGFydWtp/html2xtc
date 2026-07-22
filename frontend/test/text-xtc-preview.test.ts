// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildTextXtcPreviewCacheKey, LimitedCache, resolveTextPreviewErrorMessageKey } from "../src/lib/text-xtc-preview";
import { DEFAULT_TEXT_OPTIONS, type TextConvertOptions } from "../src/lib/text-options";

describe("resolveTextPreviewErrorMessageKey", () => {
  it("maps RATE_LIMITED to the rate-limited message", () => {
    expect(resolveTextPreviewErrorMessageKey("RATE_LIMITED")).toBe("text_x3_preview_rate_limited");
  });

  it("maps TIMEOUT to the timeout message", () => {
    expect(resolveTextPreviewErrorMessageKey("TIMEOUT")).toBe("text_x3_preview_timeout");
  });

  it("maps TEXT_TOO_LONG to the too-long message", () => {
    expect(resolveTextPreviewErrorMessageKey("TEXT_TOO_LONG")).toBe("text_x3_preview_too_long");
  });

  it("maps EMPTY_TEXT to the empty-text message", () => {
    expect(resolveTextPreviewErrorMessageKey("EMPTY_TEXT")).toBe("text_x3_preview_empty");
  });

  it("falls back to the generic failure message for every other code", () => {
    for (const code of [
      "INVALID_REQUEST",
      "INVALID_OPTIONS",
      "FONT_FETCH_FAILED",
      "PDF_GENERATION_FAILED",
      "PDF_TOO_LARGE",
      "CONTAINER_UNAVAILABLE",
      "XTC_CONVERSION_FAILED",
      "INTERNAL_ERROR",
      "UNKNOWN",
    ] as const) {
      expect(resolveTextPreviewErrorMessageKey(code)).toBe("text_x3_preview_failed");
    }
  });
});

describe("LimitedCache", () => {
  it("returns undefined for a missing key and the stored value for a present key", () => {
    const cache = new LimitedCache<string, number>(4);
    expect(cache.get("missing")).toBeUndefined();
    cache.set("x", 42);
    expect(cache.get("x")).toBe(42);
  });

  it("evicts the oldest entry once the limit is exceeded", () => {
    const cache = new LimitedCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // "a" は上限(3)超過で追い出される
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("re-setting an existing key moves it to the most-recently-used end", () => {
    const cache = new LimitedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10); // "a" を再設定 → 最古は "b" になる
    cache.set("c", 3); // 上限(2)超過で最古の "b" が追い出される
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(10);
    expect(cache.get("c")).toBe(3);
  });

  it("get does not refresh recency — only set does", () => {
    const cache = new LimitedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // 読むだけでは最近使用扱いにならない
    cache.set("c", 3); // 上限(2)超過で最古の "a" が追い出される
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });
});

describe("buildTextXtcPreviewCacheKey", () => {
  function cloneOptions(overrides: Partial<TextConvertOptions> = {}): TextConvertOptions {
    return {
      ...DEFAULT_TEXT_OPTIONS,
      margins: { ...DEFAULT_TEXT_OPTIONS.margins },
      ...overrides,
    };
  }

  it("returns the same key for identical (fullText, options)", () => {
    const key1 = buildTextXtcPreviewCacheKey("hello world", cloneOptions());
    const key2 = buildTextXtcPreviewCacheKey("hello world", cloneOptions());
    expect(key1).toBe(key2);
  });

  it("changes when the body text differs", () => {
    const options = cloneOptions();
    const key1 = buildTextXtcPreviewCacheKey("hello", options);
    const key2 = buildTextXtcPreviewCacheKey("world", options);
    expect(key1).not.toBe(key2);
  });

  it("changes when a top-level options field differs", () => {
    const base = buildTextXtcPreviewCacheKey("hello", cloneOptions());
    const variants: Array<Partial<TextConvertOptions>> = [
      { fontSizePx: DEFAULT_TEXT_OPTIONS.fontSizePx + 1 },
      { layout: "vertical" },
      { textAlign: "justify" },
      { title: "changed title" },
      { showPageNumbers: !DEFAULT_TEXT_OPTIONS.showPageNumbers },
    ];
    for (const variant of variants) {
      const changedKey = buildTextXtcPreviewCacheKey("hello", cloneOptions(variant));
      expect(changedKey).not.toBe(base);
    }
  });

  it("changes when a nested margins field differs", () => {
    const base = buildTextXtcPreviewCacheKey("hello", cloneOptions());
    const changed = cloneOptions({ margins: { ...DEFAULT_TEXT_OPTIONS.margins, top: DEFAULT_TEXT_OPTIONS.margins.top + 1 } });
    expect(buildTextXtcPreviewCacheKey("hello", changed)).not.toBe(base);
  });

  // aozora-text-conversion 仕様書 §14.3: inputFormat が異なれば同じ本文でも
  // 別キーになる（selectTextPreview の抽出結果自体が変わりうる上、options の
  // JSON化にも inputFormat が含まれるため、二重に分離される）。
  it("changes when inputFormat differs between plain and aozora for the same body text", () => {
    const plainKey = buildTextXtcPreviewCacheKey("同じ本文です。", cloneOptions({ inputFormat: "plain" }));
    const aozoraKey = buildTextXtcPreviewCacheKey("同じ本文です。", cloneOptions({ inputFormat: "aozora" }));
    expect(plainKey).not.toBe(aozoraKey);
  });
});
