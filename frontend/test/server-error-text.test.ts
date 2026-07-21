// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { resolveServerErrorKey } from "../src/lib/server-error-text";

// resolveServerErrorKey mirrors the stable messages src/pdf-upload.ts's
// uploadedPdfErrorMessage() (and the pre-existing render-PDF/XTC-conversion
// messages from src/workflow.ts) produce. Keeping this in sync with both
// sides of the contract is exactly what this test guards against drifting.
describe("resolveServerErrorKey", () => {
  it("maps the rendered-PDF size limit message (URL source)", () => {
    expect(resolveServerErrorKey("rendered PDF exceeds the 50331648 byte limit")).toBe(
      "pdf_too_large",
    );
  });

  it("maps the uploaded-PDF size limit message", () => {
    expect(resolveServerErrorKey("uploaded PDF exceeds the 50331648 byte limit")).toBe(
      "pdf_err_too_large",
    );
  });

  it("maps each uploadedPdfErrorMessage() code string", () => {
    expect(resolveServerErrorKey("uploaded file is not a PDF")).toBe("pdf_err_not_pdf");
    expect(resolveServerErrorKey("invalid PDF conversion options")).toBe("pdf_options_invalid");
    expect(resolveServerErrorKey("uploaded PDF is encrypted")).toBe("pdf_err_encrypted");
    expect(resolveServerErrorKey("unable to parse uploaded PDF")).toBe("pdf_err_parse_failed");
    expect(resolveServerErrorKey("invalid page range for uploaded PDF")).toBe(
      "pdf_err_page_range_invalid",
    );
    expect(resolveServerErrorKey("no pages selected for uploaded PDF")).toBe(
      "pdf_err_no_pages_selected",
    );
  });

  it("maps the generalized fallback message to the parse-failed key", () => {
    expect(resolveServerErrorKey("invalid or unsupported PDF")).toBe("pdf_err_parse_failed");
  });

  it("maps the shared timeout and generic conversion-failure messages", () => {
    expect(resolveServerErrorKey("XTC conversion timed out; the document is too large")).toBe(
      "pdf_err_timeout",
    );
    expect(resolveServerErrorKey("XTC conversion failed")).toBe("pdf_err_convert_failed");
  });

  it("returns null for unrecognized text so the caller can fall back to the raw string", () => {
    expect(resolveServerErrorKey("some brand-new server message")).toBeNull();
  });
});
