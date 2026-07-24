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

  // render-pdf/render-text-pdf/render-epub-pdf steps (src/workflow.ts):
  // previously unmapped entirely, so "PDF generation failed" reached users
  // untranslated even in the Japanese UI (the bug this pair of keys fixes).
  it("maps the render-step generic and timeout-specific messages (src/workflow.ts)", () => {
    expect(resolveServerErrorKey("PDF generation failed")).toBe("pdf_err_render_failed");
    expect(resolveServerErrorKey("PDF generation timed out; retrying may succeed")).toBe(
      "pdf_err_render_timeout",
    );
  });

  // 青空文庫PDFタイムアウト時の4分割フォールバック(src/workflow.ts,
  // src/aozora-fallback/*)の固定文言。専用のi18nキーは新設せず既存キーへ合流。
  it("maps the Aozora timeout-fallback's fixed messages (src/workflow.ts / src/aozora-fallback/*)", () => {
    expect(resolveServerErrorKey("PDF generation timed out after fallback splitting")).toBe(
      "pdf_err_render_timeout",
    );
    expect(resolveServerErrorKey("PDF merge failed")).toBe("pdf_err_render_failed");
    expect(resolveServerErrorKey("merged PDF page count mismatch")).toBe("pdf_err_render_failed");
    expect(resolveServerErrorKey("generated PDF is too large to merge")).toBe("pdf_too_large");
    expect(resolveServerErrorKey("the document could not be split safely")).toBe(
      "pdf_err_render_failed",
    );
  });

  // TXTアップロード系の対応表は src/text-upload.ts#textPrepareErrorMessage と
  // src/workflow.ts#runTextSource の実装（バックエンド確定後）に対して突き合わせ
  // 済み。ここでの文字列は実際に投げられる安定文字列そのもの。
  it("maps textPrepareErrorMessage()'s stable strings (src/text-upload.ts)", () => {
    expect(resolveServerErrorKey("text file is empty")).toBe("text_err_empty");
    expect(resolveServerErrorKey("unable to determine the text encoding")).toBe("text_err_encoding_unknown");
    expect(resolveServerErrorKey("UTF-16 is not supported; convert the file to UTF-8")).toBe("text_err_utf16");
    expect(resolveServerErrorKey("uploaded file is not a plain text file")).toBe("text_err_binary");
    // 修正前に localStorage 履歴へ保存された、Workflows のクラス名プレフィックス付き文字列
    expect(
      resolveServerErrorKey("NonRetryableError: uploaded file is not a plain text file"),
    ).toBe("text_err_binary");
    expect(resolveServerErrorKey("NonRetryableError: uploaded PDF is encrypted")).toBe(
      "pdf_err_encrypted",
    );
    expect(resolveServerErrorKey("text is too long to convert")).toBe("text_err_too_many_chars");
    expect(resolveServerErrorKey("line count exceeds the limit")).toBe("text_err_too_many_lines");
    expect(resolveServerErrorKey("a line exceeds the maximum line length")).toBe("text_err_line_too_long");
  });

  it("maps the upload-time Content-Length size limit message (src/index.ts#handleCreateTextJob)", () => {
    expect(resolveServerErrorKey("uploaded text file exceeds the 5242880 byte limit")).toBe(
      "text_err_too_large",
    );
  });

  it("maps the TXT-specific rendered-PDF size limit message, distinct from the URL/PDF one", () => {
    expect(
      resolveServerErrorKey("rendered PDF exceeds the 50331648 byte limit; reduce the font size or margins"),
    ).toBe("text_err_pdf_too_large");
    // Same byte-limit prefix as the URL/PDF-source message, but with a different
    // suffix ("try a shorter page..." vs "reduce the font size or margins") — must
    // resolve to the distinct TXT-context key, not pdf_too_large.
    expect(
      resolveServerErrorKey(
        "rendered PDF exceeds the 50331648 byte limit; try a shorter page or the layout-preserving (full) mode",
      ),
    ).toBe("pdf_too_large");
  });

  it("TXT jobs' final XTC-conversion failure reuses the shared generic key (identical string across all sources)", () => {
    expect(resolveServerErrorKey("XTC conversion failed")).toBe("pdf_err_convert_failed");
  });

  // review-phase45.md M2: the upload-time 413 (src/index.ts#handleCreateEpubJob)
  // and prepare-epub's defensive re-check (src/workflow.ts) both throw this
  // byte-count message — distinct from "EPUB is too large to convert" (the
  // EpubError thrown for the generated-HTML size cap), but the same
  // user-facing key as PDF's analogous pdf_err_too_large mapping.
  it("maps the upload-time EPUB size limit message (src/index.ts#handleCreateEpubJob, src/workflow.ts prepare-epub re-check)", () => {
    expect(resolveServerErrorKey("uploaded EPUB exceeds the 50331648 byte limit")).toBe(
      "epub_err_too_large",
    );
  });

  it("still maps the structural EPUB-too-large EpubError string to the same key", () => {
    expect(resolveServerErrorKey("EPUB is too large to convert")).toBe("epub_err_too_large");
  });
});
