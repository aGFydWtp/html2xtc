// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { MERGE_ERROR_FAILED, mergeChunkPdfs, totalBytes } from "../../src/aozora-fallback/merge-pdf";

/**
 * Synthetic multi-page PDFs generated in-process via pdf-lib (spec §23/§27:
 * "外部URLをCIから直接fetchしない" — no physical test/fixtures/pdf/*.pdf
 * files; pdf-lib itself both produces and validates them here).
 */
async function buildPdf(pageCount: number, label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 300]);
    page.drawText(`${label} page ${i}`, { x: 10, y: 10, size: 8 });
  }
  return doc.save();
}

describe("mergeChunkPdfs", () => {
  it("merges 4 chunk PDFs into one, preserving order and total page count", async () => {
    const chunks = [
      await buildPdf(3, "a"),
      await buildPdf(2, "b"),
      await buildPdf(4, "c"),
      await buildPdf(1, "d"),
    ];

    const merged = await mergeChunkPdfs(chunks);

    const reloaded = await PDFDocument.load(merged);
    expect(reloaded.getPageCount()).toBe(3 + 2 + 4 + 1);
  });

  it("the merged PDF is itself re-loadable (spec §23 '出力を再load可能')", async () => {
    const chunks = [await buildPdf(1, "x"), await buildPdf(1, "y")];
    const merged = await mergeChunkPdfs(chunks);
    await expect(PDFDocument.load(merged)).resolves.toBeDefined();
  });

  it("rejects a corrupted chunk with the fixed 'PDF merge failed' message", async () => {
    const good = await buildPdf(2, "good");
    const corrupted = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]); // "%PDF" + garbage

    await expect(mergeChunkPdfs([good, corrupted])).rejects.toThrow(MERGE_ERROR_FAILED);
  });

  it("rejects an empty byte array as a corrupted chunk", async () => {
    const good = await buildPdf(1, "good");
    await expect(mergeChunkPdfs([good, new Uint8Array(0)])).rejects.toThrow(MERGE_ERROR_FAILED);
  });
});

describe("totalBytes", () => {
  it("sums byte lengths", () => {
    expect(totalBytes([new Uint8Array(3), new Uint8Array(5)])).toBe(8);
    expect(totalBytes([])).toBe(0);
  });
});
