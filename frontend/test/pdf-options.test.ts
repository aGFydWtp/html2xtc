// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PDF_OPTIONS,
  encodeBase64UrlUtf8,
  encodeFileNameHeader,
  encodePdfOptionsHeader,
  isValidPdfOptions,
  type PdfConvertOptions,
  validatePdfOptions,
} from "../src/lib/pdf-options";

function withOverrides(overrides: Partial<PdfConvertOptions>): PdfConvertOptions {
  return { ...DEFAULT_PDF_OPTIONS, crop: { ...DEFAULT_PDF_OPTIONS.crop }, ...overrides };
}

describe("validatePdfOptions", () => {
  it("accepts the default options", () => {
    expect(validatePdfOptions(DEFAULT_PDF_OPTIONS)).toEqual([]);
    expect(isValidPdfOptions(DEFAULT_PDF_OPTIONS)).toBe(true);
  });

  it("accepts crop boundary values (0.0 and 0.4)", () => {
    const options = withOverrides({ crop: { top: 0, right: 0.4, bottom: 0, left: 0 } });
    expect(validatePdfOptions(options)).toEqual([]);
  });

  it("rejects crop above 0.4", () => {
    const options = withOverrides({ crop: { top: 0.41, right: 0, bottom: 0, left: 0 } });
    expect(validatePdfOptions(options).some((e) => e.field === "crop.top")).toBe(true);
  });

  it("rejects crop left+right totalling >= 0.8", () => {
    const options = withOverrides({ crop: { top: 0, right: 0.4, bottom: 0, left: 0.4 } });
    expect(validatePdfOptions(options).some((e) => e.field === "crop.left+right")).toBe(true);
  });

  it("rejects crop top+bottom totalling >= 0.8", () => {
    const options = withOverrides({ crop: { top: 0.4, right: 0, bottom: 0.4, left: 0 } });
    expect(validatePdfOptions(options).some((e) => e.field === "crop.top+bottom")).toBe(true);
  });

  it("accepts threshold boundary values", () => {
    expect(validatePdfOptions(withOverrides({ threshold: 0 }))).toEqual([]);
    expect(validatePdfOptions(withOverrides({ threshold: 255 }))).toEqual([]);
  });

  it("rejects threshold out of range", () => {
    expect(validatePdfOptions(withOverrides({ threshold: -1 })).length).toBeGreaterThan(0);
    expect(validatePdfOptions(withOverrides({ threshold: 256 })).length).toBeGreaterThan(0);
    expect(validatePdfOptions(withOverrides({ threshold: 1.5 })).length).toBeGreaterThan(0);
  });

  it("accepts margin boundary values", () => {
    expect(validatePdfOptions(withOverrides({ marginPx: 0 }))).toEqual([]);
    expect(validatePdfOptions(withOverrides({ marginPx: 64 }))).toEqual([]);
  });

  it("rejects margin out of range", () => {
    expect(validatePdfOptions(withOverrides({ marginPx: -1 })).length).toBeGreaterThan(0);
    expect(validatePdfOptions(withOverrides({ marginPx: 65 })).length).toBeGreaterThan(0);
  });

  it("accepts ditherStrength boundary values", () => {
    expect(validatePdfOptions(withOverrides({ ditherStrength: 0 }))).toEqual([]);
    expect(validatePdfOptions(withOverrides({ ditherStrength: 1 }))).toEqual([]);
  });

  it("rejects ditherStrength out of range", () => {
    expect(validatePdfOptions(withOverrides({ ditherStrength: -0.01 })).length).toBeGreaterThan(0);
    expect(validatePdfOptions(withOverrides({ ditherStrength: 1.01 })).length).toBeGreaterThan(0);
  });

  it("rejects an invalid rotation", () => {
    // @ts-expect-error intentionally invalid for the test
    expect(validatePdfOptions(withOverrides({ rotation: 45 })).length).toBeGreaterThan(0);
  });

  it("rejects an invalid fit", () => {
    // @ts-expect-error intentionally invalid for the test
    expect(validatePdfOptions(withOverrides({ fit: "stretch" })).length).toBeGreaterThan(0);
  });

  it("rejects invalid pages syntax", () => {
    expect(validatePdfOptions(withOverrides({ pages: "1-a" })).some((e) => e.field === "pages")).toBe(true);
  });
});

describe("base64url encoding", () => {
  it("round-trips ASCII text without padding characters", () => {
    const encoded = encodeBase64UrlUtf8("document.pdf");
    expect(encoded).not.toMatch(/[+/=]/);
    expect(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))).toBe("document.pdf");
  });

  it("encodes UTF-8 filenames without base64url special characters", () => {
    const encoded = encodeFileNameHeader("日本語.pdf");
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("encodes PdfConvertOptions as base64url JSON", () => {
    const encoded = encodePdfOptionsHeader(DEFAULT_PDF_OPTIONS);
    const json = decodeURIComponent(
      atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    expect(JSON.parse(json)).toEqual(DEFAULT_PDF_OPTIONS);
  });
});
