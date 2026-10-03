// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

// pdfjs-dist は loadPdfDocument() の中で動的 import される。読み込み（モジュール評価）に
// 失敗しても PDF 機能の失敗として表面化し、SPA 全体には波及しないことを確かめる。
afterEach(() => {
  vi.doUnmock("pdfjs-dist");
  vi.resetModules();
});

class FakePasswordException extends Error {}

function fakePdfjs(overrides: Record<string, unknown> = {}) {
  const GlobalWorkerOptions = { workerSrc: "" };
  const destroy = vi.fn(async () => {});
  const getDocument = vi.fn(() => ({ promise: Promise.resolve({ numPages: 3 }), destroy }));
  return {
    GlobalWorkerOptions,
    destroy,
    getDocument,
    module: { getDocument, GlobalWorkerOptions, PasswordException: FakePasswordException, ...overrides },
  };
}

describe("loadPdfDocument (lazy pdfjs-dist)", () => {
  it("does not load pdfjs-dist on import of the module itself", async () => {
    const factory = vi.fn(() => ({}));
    vi.doMock("pdfjs-dist", factory);
    await import("../src/lib/pdf-loader");
    expect(factory).not.toHaveBeenCalled();
  });

  it("maps a pdfjs-dist load failure to PdfLoadError(engine_load_failed)", async () => {
    vi.doMock("pdfjs-dist", () => {
      throw new ReferenceError("Iterator is not defined");
    });
    const { loadPdfDocument, PdfLoadError } = await import("../src/lib/pdf-loader");
    const err = await loadPdfDocument(new ArrayBuffer(8)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfLoadError);
    expect((err as InstanceType<typeof PdfLoadError>).kind).toBe("engine_load_failed");
  });

  it("keeps parse_failed for failures after pdfjs-dist has loaded (broken PDF)", async () => {
    const f = fakePdfjs({
      getDocument: vi.fn(() => ({ promise: Promise.reject(new Error("Invalid PDF structure")), destroy: vi.fn() })),
    });
    vi.doMock("pdfjs-dist", () => f.module);
    const { loadPdfDocument, PdfLoadError } = await import("../src/lib/pdf-loader");
    const err = await loadPdfDocument(new ArrayBuffer(8)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfLoadError);
    expect((err as InstanceType<typeof PdfLoadError>).kind).toBe("parse_failed");
  });

  it("loads pdfjs-dist, sets workerSrc, and returns the document", async () => {
    const f = fakePdfjs();
    vi.doMock("pdfjs-dist", () => f.module);
    const { loadPdfDocument } = await import("../src/lib/pdf-loader");
    const loaded = await loadPdfDocument(new ArrayBuffer(8));
    expect(loaded.document).toEqual({ numPages: 3 });
    expect(f.GlobalWorkerOptions.workerSrc).toContain("pdf.worker.min");
    await loaded.destroy();
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("sets workerSrc only once across repeated calls", async () => {
    let sets = 0;
    let value = "";
    const GlobalWorkerOptions = {
      get workerSrc() { return value; },
      set workerSrc(v: string) { sets += 1; value = v; },
    };
    const f = fakePdfjs({ GlobalWorkerOptions });
    vi.doMock("pdfjs-dist", () => f.module);
    const { loadPdfDocument } = await import("../src/lib/pdf-loader");
    await loadPdfDocument(new ArrayBuffer(8));
    await loadPdfDocument(new ArrayBuffer(8));
    await loadPdfDocument(new ArrayBuffer(8));
    expect(sets).toBe(1);
    expect(f.getDocument).toHaveBeenCalledTimes(3);
  });

  it("shares a single pdfjs-dist load between concurrent calls", async () => {
    const f = fakePdfjs();
    const factory = vi.fn(() => f.module);
    vi.doMock("pdfjs-dist", factory);
    const { loadPdfDocument } = await import("../src/lib/pdf-loader");
    await Promise.all([loadPdfDocument(new ArrayBuffer(8)), loadPdfDocument(new ArrayBuffer(8))]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("can retry on the same module instance after a pdfjs-dist load failure", async () => {
    const f = fakePdfjs();
    let calls = 0;
    vi.doMock("pdfjs-dist", () => {
      calls += 1;
      if (calls === 1) throw new Error("Failed to fetch dynamically imported module");
      return f.module;
    });
    const { loadPdfDocument, PdfLoadError } = await import("../src/lib/pdf-loader");
    const first = await loadPdfDocument(new ArrayBuffer(8)).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(PdfLoadError);
    const second = await loadPdfDocument(new ArrayBuffer(8));
    expect(second.document).toEqual({ numPages: 3 });
  });

  it("maps PasswordException to password_protected", async () => {
    const f = fakePdfjs({
      getDocument: vi.fn(() => ({ promise: Promise.reject(new FakePasswordException("pw")), destroy: vi.fn() })),
    });
    vi.doMock("pdfjs-dist", () => f.module);
    const { loadPdfDocument, PdfLoadError } = await import("../src/lib/pdf-loader");
    const err = await loadPdfDocument(new ArrayBuffer(8)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfLoadError);
    expect((err as InstanceType<typeof PdfLoadError>).kind).toBe("password_protected");
  });
});
