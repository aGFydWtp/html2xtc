// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { MERGE_ERROR_FAILED, mergeChunkPdfs, totalBytes } from "../../src/aozora-fallback/merge-pdf";

/**
 * Synthetic multi-page PDFs generated in-process via pdf-lib (spec §23/§27:
 * "外部URLをCIから直接fetchしない" — no physical test/fixtures/pdf/*.pdf
 * files; pdf-lib itself both produces and validates them here).
 *
 * Every page in one chunk shares a WIDTH unique to that chunk (height stays
 * fixed at 300) — not just a distinct page count. Order-checking via text
 * extraction is impractical with pdf-lib alone, but a per-chunk-unique
 * dimension read back off each output page (PDFPage#getWidth) is a
 * mechanical, unambiguous stand-in: reading the merged document's page
 * widths in order reconstructs exactly which chunk contributed each page
 * and in what order, so a swapped/reversed/interleaved merge is guaranteed
 * to produce a width sequence that does NOT match the expected one — a
 * "totals only" assertion (e.g. matching page counts under a different
 * chunk order) could pass by coincidence for chunks sharing counts, but a
 * per-chunk-unique width cannot.
 */
async function buildPdf(pageCount: number, width: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([width, 300]);
  }
  return doc.save();
}

describe("mergeChunkPdfs", () => {
  it("merges 4 chunk PDFs into one, preserving order (verified via each chunk's unique page width)", async () => {
    // 4 chunks with distinct page counts AND distinct widths, so any
    // reordering (reversal, adjacent swap, ...) changes the expected width
    // sequence.
    const chunkSpecs = [
      { pageCount: 3, width: 150 },
      { pageCount: 2, width: 180 },
      { pageCount: 4, width: 210 },
      { pageCount: 1, width: 240 },
    ];
    const chunks = await Promise.all(chunkSpecs.map((c) => buildPdf(c.pageCount, c.width)));

    const result = await mergeChunkPdfs(chunks);

    expect(result.inputPageCounts).toEqual(chunkSpecs.map((c) => c.pageCount));
    expect(result.outputPages).toBe(3 + 2 + 4 + 1);

    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(result.outputPages);

    const expectedWidths = chunkSpecs.flatMap((c) => Array(c.pageCount).fill(c.width));
    const actualWidths = reloaded.getPages().map((page) => page.getWidth());
    expect(actualWidths).toEqual(expectedWidths);
  });

  it("detects a reversed merge order (sanity check on the width-sequence assertion itself)", async () => {
    // Same chunk shapes as above, but merged in REVERSE — this must NOT
    // produce the forward-order width sequence, proving the assertion
    // technique above actually discriminates order (not just totals).
    const chunkSpecs = [
      { pageCount: 3, width: 150 },
      { pageCount: 2, width: 180 },
      { pageCount: 4, width: 210 },
      { pageCount: 1, width: 240 },
    ];
    const chunks = await Promise.all(chunkSpecs.map((c) => buildPdf(c.pageCount, c.width)));

    const result = await mergeChunkPdfs([...chunks].reverse());
    const reloaded = await PDFDocument.load(result.bytes);

    const forwardOrderWidths = chunkSpecs.flatMap((c) => Array(c.pageCount).fill(c.width));
    const actualWidths = reloaded.getPages().map((page) => page.getWidth());
    expect(actualWidths).not.toEqual(forwardOrderWidths);
    // It does match the reversed expectation, confirming mergeChunkPdfs
    // itself never reorders — the caller (src/workflow.ts) is solely
    // responsible for passing chunks in manifest order.
    const reverseOrderWidths = [...chunkSpecs].reverse().flatMap((c) => Array(c.pageCount).fill(c.width));
    expect(actualWidths).toEqual(reverseOrderWidths);
  });

  it("the merged PDF is itself re-loadable (spec §23 '出力を再load可能')", async () => {
    const chunks = [await buildPdf(1, 100), await buildPdf(1, 110)];
    const result = await mergeChunkPdfs(chunks);
    await expect(PDFDocument.load(result.bytes)).resolves.toBeDefined();
  });

  it("returns per-chunk input page counts alongside the merged output", async () => {
    const chunks = [await buildPdf(2, 100), await buildPdf(5, 110), await buildPdf(1, 120)];
    const result = await mergeChunkPdfs(chunks);
    expect(result.inputPageCounts).toEqual([2, 5, 1]);
    expect(result.outputPages).toBe(8);
  });

  it("rejects a corrupted chunk with the fixed 'PDF merge failed' message", async () => {
    const good = await buildPdf(2, 100);
    const corrupted = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]); // "%PDF" + garbage

    await expect(mergeChunkPdfs([good, corrupted])).rejects.toThrow(MERGE_ERROR_FAILED);
  });

  it("rejects an empty byte array as a corrupted chunk", async () => {
    const good = await buildPdf(1, 100);
    await expect(mergeChunkPdfs([good, new Uint8Array(0)])).rejects.toThrow(MERGE_ERROR_FAILED);
  });
});

describe("totalBytes", () => {
  it("sums byte lengths", () => {
    expect(totalBytes([new Uint8Array(3), new Uint8Array(5)])).toBe(8);
    expect(totalBytes([])).toBe(0);
  });
});
