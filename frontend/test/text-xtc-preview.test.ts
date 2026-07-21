// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { resolveTextPreviewErrorMessageKey } from "../src/lib/text-xtc-preview";

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
