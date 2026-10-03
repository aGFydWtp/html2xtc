// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

// pdfjs-dist は loadPdfDocument() の中で動的 import される。読み込み（モジュール評価）に
// 失敗しても PDF 機能の失敗として表面化し、SPA 全体には波及しないことを確かめる。
afterEach(() => {
  vi.doUnmock("pdfjs-dist");
  vi.resetModules();
});

class FakePasswordException extends Error {}

describe("loadPdfDocument (lazy pdfjs-dist)", () => {
  it("does not load pdfjs-dist on import of the module itself", async () => {
    const factory = vi.fn(() => ({}));
    vi.doMock("pdfjs-dist", factory);
    await import("../src/lib/pdf-loader");
    expect(factory).not.toHaveBeenCalled();
  });

  it("maps a pdfjs-dist load failure to PdfLoadError(parse_failed)", async () => {
    vi.doMock("pdfjs-dist", () => {
      throw new ReferenceError("Iterator is not defined");
    });
    const { loadPdfDocument, PdfLoadError } = await import("../src/lib/pdf-loader");
    const err = await loadPdfDocument(new ArrayBuffer(8)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfLoadError);
    expect((err as InstanceType<typeof PdfLoadError>).kind).toBe("parse_failed");
  });

  it("loads pdfjs-dist, sets workerSrc once, and returns the document", async () => {
    const GlobalWorkerOptions = { workerSrc: "" };
    const destroy = vi.fn(async () => {});
    const getDocument = vi.fn(() => ({ promise: Promise.resolve({ numPages: 3 }), destroy }));
    vi.doMock("pdfjs-dist", () => ({ getDocument, GlobalWorkerOptions, PasswordException: FakePasswordException }));
    const { loadPdfDocument } = await import("../src/lib/pdf-loader");
    const loaded = await loadPdfDocument(new ArrayBuffer(8));
    expect(loaded.document).toEqual({ numPages: 3 });
    expect(GlobalWorkerOptions.workerSrc).toContain("pdf.worker.min");
    await loaded.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("maps PasswordException to password_protected", async () => {
    const getDocument = vi.fn(() => ({ promise: Promise.reject(new FakePasswordException("pw")), destroy: vi.fn() }));
    vi.doMock("pdfjs-dist", () => ({
      getDocument,
      GlobalWorkerOptions: { workerSrc: "" },
      PasswordException: FakePasswordException,
    }));
    const { loadPdfDocument, PdfLoadError } = await import("../src/lib/pdf-loader");
    const err = await loadPdfDocument(new ArrayBuffer(8)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfLoadError);
    expect((err as InstanceType<typeof PdfLoadError>).kind).toBe("password_protected");
  });
});
