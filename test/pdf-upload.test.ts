// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/base64url";
import { inputPdfKey } from "../src/jobs";
import {
  checkContentLength,
  decodeFilenameHeader,
  isAllowedPdfContentType,
  resolveMaxUploadPdfBytes,
  saveUploadedPdf,
  sanitizeUploadFilename,
  uploadedPdfErrorMessage,
} from "../src/pdf-upload";

describe("isAllowedPdfContentType", () => {
  it("accepts application/pdf and application/x-pdf", () => {
    expect(isAllowedPdfContentType("application/pdf")).toBe(true);
    expect(isAllowedPdfContentType("application/x-pdf")).toBe(true);
  });

  it("ignores media-type parameters and is case-insensitive", () => {
    expect(isAllowedPdfContentType("Application/PDF; charset=binary")).toBe(true);
  });

  it("rejects everything else, including a missing header", () => {
    expect(isAllowedPdfContentType(null)).toBe(false);
    expect(isAllowedPdfContentType("text/plain")).toBe(false);
    expect(isAllowedPdfContentType("application/json")).toBe(false);
  });
});

describe("checkContentLength (spec §8.1)", () => {
  const MAX = 1000;

  it("reports missing when the header is absent", () => {
    expect(checkContentLength(null, MAX)).toEqual({ kind: "missing" });
  });

  it("reports invalid for zero, negative, or non-numeric values", () => {
    expect(checkContentLength("0", MAX)).toEqual({ kind: "invalid" });
    expect(checkContentLength("-5", MAX)).toEqual({ kind: "invalid" });
    expect(checkContentLength("abc", MAX)).toEqual({ kind: "invalid" });
    expect(checkContentLength("12.5", MAX)).toEqual({ kind: "invalid" });
  });

  it("reports too-large when the declared size exceeds the cap", () => {
    expect(checkContentLength("1001", MAX)).toEqual({ kind: "too-large", length: 1001 });
  });

  it("accepts a positive integer at or under the cap", () => {
    expect(checkContentLength("1000", MAX)).toEqual({ kind: "ok", length: 1000 });
    expect(checkContentLength("1", MAX)).toEqual({ kind: "ok", length: 1 });
  });
});

describe("resolveMaxUploadPdfBytes", () => {
  it("defaults to 48 MiB", () => {
    expect(resolveMaxUploadPdfBytes({})).toBe(50_331_648);
  });

  it("honors a positive override", () => {
    expect(resolveMaxUploadPdfBytes({ MAX_UPLOAD_PDF_BYTES: "1000000" })).toBe(1_000_000);
  });

  it("falls back on garbage or non-positive values", () => {
    expect(resolveMaxUploadPdfBytes({ MAX_UPLOAD_PDF_BYTES: "banana" })).toBe(50_331_648);
    expect(resolveMaxUploadPdfBytes({ MAX_UPLOAD_PDF_BYTES: "0" })).toBe(50_331_648);
    expect(resolveMaxUploadPdfBytes({ MAX_UPLOAD_PDF_BYTES: "-1" })).toBe(50_331_648);
  });
});

describe("sanitizeUploadFilename / decodeFilenameHeader (spec §8.1)", () => {
  it("passes a normal filename through unchanged", () => {
    expect(sanitizeUploadFilename("report.pdf")).toBe("report.pdf");
  });

  it("appends .pdf when there is no extension", () => {
    expect(sanitizeUploadFilename("report")).toBe("report.pdf");
  });

  it("strips control characters", () => {
    const withControlChars = `bad${String.fromCharCode(0)}name${String.fromCharCode(31)}.pdf`;
    expect(sanitizeUploadFilename(withControlChars)).toBe("badname.pdf");
  });

  it("strips path separators (never used as a path — spec §12.3)", () => {
    expect(sanitizeUploadFilename("../../etc/passwd.pdf")).toBe("....etcpasswd.pdf");
    expect(sanitizeUploadFilename("C:\\Users\\a\\report.pdf")).toBe("C:Usersareport.pdf");
  });

  it("falls back to document.pdf when empty after cleanup", () => {
    expect(sanitizeUploadFilename("")).toBe("document.pdf");
    expect(sanitizeUploadFilename("   ")).toBe("document.pdf");
    expect(sanitizeUploadFilename("///")).toBe("document.pdf");
  });

  it("caps length at 255 code points", () => {
    const long = "a".repeat(300) + ".pdf";
    const result = sanitizeUploadFilename(long);
    expect(Array.from(result).length).toBeLessThanOrEqual(255 + 4);
  });

  it("decodeFilenameHeader defaults to document.pdf when the header is absent", () => {
    expect(decodeFilenameHeader(null)).toBe("document.pdf");
  });

  it("decodeFilenameHeader decodes a base64url UTF-8 filename", () => {
    const encoded = encodeBase64Url("請求書.pdf");
    expect(decodeFilenameHeader(encoded)).toBe("請求書.pdf");
  });

  it("decodeFilenameHeader degrades to the default rather than failing the request on bad base64url", () => {
    // Unlike X-Pdf-Options, a broken filename header must not turn into a
    // 400 — it's display/title use only (spec §12.3).
    expect(decodeFilenameHeader("not valid base64!")).toBe("document.pdf");
  });
});

class FakeR2Bucket {
  objects = new Map<string, { size: number; body: ReadableStream }>();
  deletedKeys: string[] = [];
  putShouldThrow = false;
  putStoresWrongSize: number | null = null;

  async put(key: string, value: ReadableStream): Promise<void> {
    if (this.putShouldThrow) {
      throw new Error("simulated R2 outage");
    }
    // Drain the stream like a real put() would, so callers awaiting put()
    // see the request body fully consumed.
    const reader = value.getReader();
    let size = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
    }
    this.objects.set(key, {
      size: this.putStoresWrongSize ?? size,
      body: new ReadableStream(),
    });
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { size: object.size } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
}

function streamOf(bytes: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("saveUploadedPdf", () => {
  const KEY = inputPdfKey("0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f");

  it("stores the body and reports ok when the stored size matches", async () => {
    const bucket = new FakeR2Bucket();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await saveUploadedPdf(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(bytes),
      bytes.byteLength,
      "report.pdf",
    );
    expect(result).toEqual({ ok: true });
    expect(bucket.objects.has(KEY)).toBe(true);
  });

  it("deletes the object and returns 500 when R2 put() throws", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putShouldThrow = true;
    const result = await saveUploadedPdf(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(new Uint8Array([1])),
      1,
      "report.pdf",
    );
    expect(result).toEqual({ ok: false, status: 500, error: "failed to store upload" });
  });

  it("deletes the object and returns 400 when the stored size does not match Content-Length", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putStoresWrongSize = 3; // simulates a truncated/mismatched upload
    const result = await saveUploadedPdf(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(new Uint8Array([1, 2, 3, 4])),
      4,
      "report.pdf",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
    expect(bucket.deletedKeys).toContain(KEY);
  });
});

describe("uploadedPdfErrorMessage (Container error-code contract, spec §9.4/§11.11)", () => {
  it("maps each known code from converter/pdf_upload.py to its stable message", () => {
    expect(uploadedPdfErrorMessage(JSON.stringify({ error: "x", code: "not_pdf" }))).toBe(
      "uploaded file is not a PDF",
    );
    expect(
      uploadedPdfErrorMessage(JSON.stringify({ error: "x", code: "invalid_pdf_options" })),
    ).toBe("invalid PDF conversion options");
    expect(uploadedPdfErrorMessage(JSON.stringify({ error: "x", code: "encrypted_pdf" }))).toBe(
      "uploaded PDF is encrypted",
    );
    expect(
      uploadedPdfErrorMessage(JSON.stringify({ error: "x", code: "pdf_parse_failed" })),
    ).toBe("unable to parse uploaded PDF");
    expect(
      uploadedPdfErrorMessage(JSON.stringify({ error: "x", code: "page_range_invalid" })),
    ).toBe("invalid page range for uploaded PDF");
    expect(
      uploadedPdfErrorMessage(JSON.stringify({ error: "x", code: "no_pages_selected" })),
    ).toBe("no pages selected for uploaded PDF");
  });

  it("falls back to the generalized message for an unrecognized code", () => {
    expect(
      uploadedPdfErrorMessage(JSON.stringify({ error: "x", code: "some_future_code" })),
    ).toBe("invalid or unsupported PDF");
  });

  it("falls back to the generalized message when code is missing", () => {
    expect(uploadedPdfErrorMessage(JSON.stringify({ error: "x" }))).toBe(
      "invalid or unsupported PDF",
    );
  });

  it("falls back to the generalized message for a non-JSON body", () => {
    expect(uploadedPdfErrorMessage("not json at all")).toBe("invalid or unsupported PDF");
  });

  it("falls back to the generalized message for JSON that isn't an object", () => {
    expect(uploadedPdfErrorMessage(JSON.stringify(["not", "an", "object"]))).toBe(
      "invalid or unsupported PDF",
    );
  });
});
