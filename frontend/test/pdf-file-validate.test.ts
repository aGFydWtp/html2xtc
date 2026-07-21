// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_PDF_BYTES, PdfFileValidationError, validatePdfFile } from "../src/lib/pdf-file-validate";

function pdfFile(name: string, body = "%PDF-1.7\n%dummy", type = "application/pdf"): File {
  return new File([body], name, { type });
}

describe("validatePdfFile", () => {
  it("accepts a well-formed PDF file", async () => {
    await expect(validatePdfFile(pdfFile("doc.pdf"))).resolves.toBeUndefined();
  });

  it("accepts an empty MIME type (some OSes report none for .pdf)", async () => {
    await expect(validatePdfFile(pdfFile("doc.pdf", "%PDF-1.7", ""))).resolves.toBeUndefined();
  });

  it("accepts application/x-pdf", async () => {
    await expect(validatePdfFile(pdfFile("doc.pdf", "%PDF-1.7", "application/x-pdf"))).resolves.toBeUndefined();
  });

  it("rejects a non-.pdf extension", async () => {
    await expect(validatePdfFile(pdfFile("doc.txt"))).rejects.toMatchObject({ kind: "not_pdf" });
  });

  it("rejects an unsupported MIME type", async () => {
    await expect(validatePdfFile(pdfFile("doc.pdf", "%PDF-1.7", "text/plain"))).rejects.toMatchObject({ kind: "not_pdf" });
  });

  it("rejects an empty file", async () => {
    await expect(validatePdfFile(pdfFile("doc.pdf", ""))).rejects.toMatchObject({ kind: "empty" });
  });

  it("rejects a file exceeding the size limit", async () => {
    const big = new File([new Uint8Array(10)], "doc.pdf", { type: "application/pdf" });
    await expect(validatePdfFile(big, 5)).rejects.toMatchObject({ kind: "too_large" });
  });

  it("rejects a file missing the %PDF- magic bytes", async () => {
    await expect(validatePdfFile(pdfFile("doc.pdf", "not a pdf at all"))).rejects.toMatchObject({ kind: "magic_missing" });
  });

  it("uses the documented default max size", () => {
    expect(MAX_UPLOAD_PDF_BYTES).toBe(50331648);
  });

  it("is an instance of PdfFileValidationError", async () => {
    try {
      await validatePdfFile(pdfFile("doc.txt"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PdfFileValidationError);
    }
  });
});
