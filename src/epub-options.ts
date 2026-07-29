// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { decodeBase64Url } from "./base64url";
import { DEFAULT_DEVICE_ID } from "./devices";
import type { DeviceId } from "./devices";
import { sanitizeFontFamily } from "./fonts";

/**
 * EPUB upload conversion settings (EPUB_TO_XTC_IMPLEMENTATION_SPEC.md §4.1).
 * Mirrors src/text-options.ts's structure and validation stance: unlike the
 * URL-render pipeline's layout/font fields (resolveRenderOptions, which
 * fails soft), this is an upload-triggering API, so validateEpubConvertOptions
 * never implicitly corrects an out-of-range value — it 400s (spec §4.1.5).
 */

export type EpubLayout = "auto" | "horizontal" | "vertical";

export interface EpubConvertOptions {
  layout: EpubLayout;
  /** Google Fonts family name; validated by sanitizeFontFamily (src/fonts.ts). */
  font: string;
  /** CSS px. */
  fontSizePx: number;
  /** CSS px. */
  marginPx: number;
  chapterPageBreak: boolean;
  includeCover: boolean;
  includeTableOfContents: boolean;
  /**
   * Target Xteink device (src/devices.ts). Added after the initial EPUB
   * release: an absent field defaults to "x3" (full backward compatibility),
   * but a present, invalid value is a hard 400 like every other field here.
   */
  device: DeviceId;
}

/** Spec §4.1.4. */
export const DEFAULT_EPUB_OPTIONS: EpubConvertOptions = {
  layout: "auto",
  font: "BIZ UDMincho",
  fontSizePx: 24,
  marginPx: 40,
  chapterPageBreak: true,
  includeCover: true,
  includeTableOfContents: false,
  device: DEFAULT_DEVICE_ID,
};

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export type EpubOptionsResult =
  | { ok: true; options: EpubConvertOptions }
  | { ok: false; error: string };

/**
 * Validates a decoded EpubConvertOptions JSON value against spec §4.1.5.
 * Strict: out-of-range or wrong-typed fields are rejected outright, never
 * silently clamped or defaulted. Unknown extra properties are ignored.
 */
export function validateEpubConvertOptions(value: unknown): EpubOptionsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "epub options must be a JSON object" };
  }
  const v = value as Record<string, unknown>;

  if (v.layout !== "auto" && v.layout !== "horizontal" && v.layout !== "vertical") {
    return { ok: false, error: "invalid layout" };
  }
  const layout = v.layout;

  const font = sanitizeFontFamily(v.font);
  if (font === undefined) {
    return { ok: false, error: "invalid font" };
  }

  if (!isIntegerInRange(v.fontSizePx, 12, 40)) {
    return { ok: false, error: "invalid fontSizePx" };
  }
  const fontSizePx = v.fontSizePx;

  if (!isIntegerInRange(v.marginPx, 0, 120)) {
    return { ok: false, error: "invalid marginPx" };
  }
  const marginPx = v.marginPx;

  if (typeof v.chapterPageBreak !== "boolean") {
    return { ok: false, error: "invalid chapterPageBreak" };
  }
  const chapterPageBreak = v.chapterPageBreak;

  if (typeof v.includeCover !== "boolean") {
    return { ok: false, error: "invalid includeCover" };
  }
  const includeCover = v.includeCover;

  if (typeof v.includeTableOfContents !== "boolean") {
    return { ok: false, error: "invalid includeTableOfContents" };
  }
  const includeTableOfContents = v.includeTableOfContents;

  // Backward compatibility (device selection was added after the initial
  // EPUB release): an absent field defaults to "x3". A present-but-invalid
  // value is still a hard rejection, per this schema's fail-hard stance.
  const deviceRaw = v.device === undefined ? DEFAULT_DEVICE_ID : v.device;
  if (deviceRaw !== "x3" && deviceRaw !== "x4") {
    return { ok: false, error: "invalid device" };
  }
  const device = deviceRaw;

  return {
    ok: true,
    options: {
      layout,
      font,
      fontSizePx,
      marginPx,
      chapterPageBreak,
      includeCover,
      includeTableOfContents,
      device,
    },
  };
}

/**
 * Decodes + validates X-Epub-Options (spec §4.1.2). A missing header falls
 * back to DEFAULT_EPUB_OPTIONS; a present-but-invalid header is always a 400
 * (spec §4.1.5: "不正なX-Epub-Optionsは400とする... アップロード系オプション
 * として厳格に検証する").
 */
export function decodeEpubOptionsHeader(headerValue: string | null): EpubOptionsResult {
  if (headerValue === null) {
    return { ok: true, options: DEFAULT_EPUB_OPTIONS };
  }
  const decoded = decodeBase64Url(headerValue);
  if (decoded === null) {
    return { ok: false, error: "X-Epub-Options is not valid base64url UTF-8" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "X-Epub-Options is not valid JSON" };
  }
  return validateEpubConvertOptions(parsed);
}
