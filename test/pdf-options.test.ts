// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/base64url";
import {
  DEFAULT_PDF_OPTIONS,
  decodePdfOptionsHeader,
  validatePdfConvertOptions,
} from "../src/pdf-upload";

describe("validatePdfConvertOptions — accepts", () => {
  it("accepts DEFAULT_PDF_OPTIONS", () => {
    const result = validatePdfConvertOptions(DEFAULT_PDF_OPTIONS);
    expect(result.ok).toBe(true);
  });

  it("ignores unknown extra fields on the input object", () => {
    const result = validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, unknownField: "x" });
    expect(result).toEqual({ ok: true, options: DEFAULT_PDF_OPTIONS });
  });

  it("accepts crop boundary values (0.0 and 0.4)", () => {
    const result = validatePdfConvertOptions({
      ...DEFAULT_PDF_OPTIONS,
      crop: { top: 0, right: 0.4, bottom: 0, left: 0.39 },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts threshold boundary values (0 and 255)", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, threshold: 0 }).ok).toBe(true);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, threshold: 255 }).ok).toBe(true);
  });

  it("accepts marginPx boundary values (0 and 64)", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, marginPx: 0 }).ok).toBe(true);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, marginPx: 64 }).ok).toBe(true);
  });

  it("accepts ditherStrength boundary values (0.0 and 1.0)", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, ditherStrength: 0 }).ok).toBe(true);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, ditherStrength: 1 }).ok).toBe(true);
  });

  it("accepts every rotation value", () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, rotation }).ok).toBe(true);
    }
  });

  it("accepts both fit values", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, fit: "contain" }).ok).toBe(true);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, fit: "cover" }).ok).toBe(true);
  });
});

describe("validatePdfConvertOptions — rejects (no implicit correction)", () => {
  it("rejects a non-object value", () => {
    expect(validatePdfConvertOptions("not an object").ok).toBe(false);
    expect(validatePdfConvertOptions(null).ok).toBe(false);
    expect(validatePdfConvertOptions([1, 2, 3]).ok).toBe(false);
  });

  it("rejects an invalid pages string rather than defaulting it", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, pages: "0" }).ok).toBe(false);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, pages: "1-a" }).ok).toBe(false);
  });

  it("rejects an unlisted rotation value rather than rounding it", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, rotation: 45 }).ok).toBe(false);
  });

  it("rejects crop values just outside [0.0, 0.4] rather than clamping", () => {
    expect(
      validatePdfConvertOptions({
        ...DEFAULT_PDF_OPTIONS,
        crop: { top: -0.01, right: 0, bottom: 0, left: 0 },
      }).ok,
    ).toBe(false);
    expect(
      validatePdfConvertOptions({
        ...DEFAULT_PDF_OPTIONS,
        crop: { top: 0.41, right: 0, bottom: 0, left: 0 },
      }).ok,
    ).toBe(false);
  });

  it("rejects crop left+right >= 0.8", () => {
    expect(
      validatePdfConvertOptions({
        ...DEFAULT_PDF_OPTIONS,
        crop: { top: 0, bottom: 0, left: 0.4, right: 0.4 },
      }).ok,
    ).toBe(false);
  });

  it("rejects crop top+bottom >= 0.8", () => {
    expect(
      validatePdfConvertOptions({
        ...DEFAULT_PDF_OPTIONS,
        crop: { left: 0, right: 0, top: 0.4, bottom: 0.4 },
      }).ok,
    ).toBe(false);
  });

  it("rejects an unlisted fit value", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, fit: "stretch" }).ok).toBe(false);
  });

  it("rejects marginPx out of [0, 64] rather than clamping", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, marginPx: -1 }).ok).toBe(false);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, marginPx: 65 }).ok).toBe(false);
  });

  it("rejects a non-integer marginPx", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, marginPx: 1.5 }).ok).toBe(false);
  });

  it("rejects threshold out of [0, 255] rather than clamping", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, threshold: -1 }).ok).toBe(false);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, threshold: 256 }).ok).toBe(false);
  });

  it("rejects a non-integer threshold", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, threshold: 128.5 }).ok).toBe(false);
  });

  it("rejects ditherStrength out of [0.0, 1.0] rather than clamping", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, ditherStrength: -0.01 }).ok).toBe(false);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, ditherStrength: 1.01 }).ok).toBe(false);
  });

  it("rejects a non-boolean dither/invert", () => {
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, dither: "yes" }).ok).toBe(false);
    expect(validatePdfConvertOptions({ ...DEFAULT_PDF_OPTIONS, invert: 1 }).ok).toBe(false);
  });

  it("rejects a missing field rather than filling in the default", () => {
    const { pages: _pages, ...rest } = DEFAULT_PDF_OPTIONS;
    expect(validatePdfConvertOptions(rest).ok).toBe(false);
  });

  it("rejects a missing crop object", () => {
    const { crop: _crop, ...rest } = DEFAULT_PDF_OPTIONS;
    expect(validatePdfConvertOptions(rest).ok).toBe(false);
  });
});

describe("decodePdfOptionsHeader", () => {
  it("falls back to DEFAULT_PDF_OPTIONS when the header is absent", () => {
    expect(decodePdfOptionsHeader(null)).toEqual({ ok: true, options: DEFAULT_PDF_OPTIONS });
  });

  it("decodes a valid base64url-encoded JSON header", () => {
    const encoded = encodeBase64Url(JSON.stringify(DEFAULT_PDF_OPTIONS));
    expect(decodePdfOptionsHeader(encoded)).toEqual({ ok: true, options: DEFAULT_PDF_OPTIONS });
  });

  it("rejects malformed base64url", () => {
    const result = decodePdfOptionsHeader("not base64url!!");
    expect(result.ok).toBe(false);
  });

  it("rejects base64url that decodes to invalid JSON", () => {
    const encoded = encodeBase64Url("{not json");
    const result = decodePdfOptionsHeader(encoded);
    expect(result.ok).toBe(false);
  });

  it("rejects base64url JSON that fails schema validation", () => {
    const encoded = encodeBase64Url(JSON.stringify({ ...DEFAULT_PDF_OPTIONS, threshold: 999 }));
    const result = decodePdfOptionsHeader(encoded);
    expect(result.ok).toBe(false);
  });
});
