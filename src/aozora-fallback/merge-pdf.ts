// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { PDFDocument } from "pdf-lib";

/**
 * Input-size/page-count gates for merge-aozora-fallback-pdf (spec §17).
 * Initial candidates per spec; not yet tuned against a measured production
 * memory/CPU ceiling (spec §4's "未検証事項" — deferred to post-deploy
 * observation, per the spec's own rollout plan §24).
 */
export const MAX_FALLBACK_MERGE_INPUT_BYTES = 48 * 1024 * 1024;
export const MAX_FALLBACK_MERGE_PAGES = 5_000;

/** Fixed client-facing messages (spec §19) — keep in sync with
 * frontend/src/lib/server-error-text.ts's mapping. */
export const MERGE_ERROR_TOO_LARGE = "generated PDF is too large to merge";
export const MERGE_ERROR_PAGE_MISMATCH = "merged PDF page count mismatch";
export const MERGE_ERROR_FAILED = "PDF merge failed";

/** mergeChunkPdfs' result: the merged bytes plus every page count the caller
 * needs for its size/page gates and diagnostic log (spec §21) — so the
 * caller never has to re-parse a PDF this function already parsed. */
export interface MergeChunkPdfsResult {
  bytes: Uint8Array;
  /** Per-chunk page count, in input (== manifest chunk) order. */
  inputPageCounts: number[];
  /** The merged output's page count — already reload-verified below, so
   * this is never a value pdf-lib itself failed to reproduce from `bytes`. */
  outputPages: number;
}

/**
 * Concatenates 4 chunk PDFs (already in the correct, manifest-derived order —
 * this function does not reorder) into a single PDF via pdf-lib's
 * load/copyPages/save (spec §16.4's reference implementation). Throws
 * MERGE_ERROR_PAGE_MISMATCH if the output page count does not equal the sum
 * of every input's page count, and MERGE_ERROR_FAILED for anything pdf-lib
 * itself throws (a chunk PDF that fails to parse/load, etc.) — both callers'
 * responsibility to turn into a NonRetryableError, since either is
 * deterministic for the same input bytes.
 *
 * Every chunk (and the merged output) is parsed by pdf-lib exactly once here
 * — callers must read page counts off the returned MergeChunkPdfsResult
 * rather than re-parsing (spec §4's unverified production memory/CPU ceiling
 * makes every avoidable re-parse worth avoiding).
 */
export async function mergeChunkPdfs(
  chunks: readonly Uint8Array[],
): Promise<MergeChunkPdfsResult> {
  let output: PDFDocument;
  const inputPageCounts: number[] = [];
  let expectedPages = 0;
  try {
    output = await PDFDocument.create();
    for (const bytes of chunks) {
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      const indices = source.getPageIndices();
      inputPageCounts.push(indices.length);
      expectedPages += indices.length;
      const pages = await output.copyPages(source, indices);
      for (const page of pages) {
        output.addPage(page);
      }
    }
  } catch (error) {
    console.error("mergeChunkPdfs failed", error);
    throw new Error(MERGE_ERROR_FAILED);
  }

  if (output.getPageCount() !== expectedPages) {
    throw new Error(MERGE_ERROR_PAGE_MISMATCH);
  }

  let merged: Uint8Array;
  try {
    merged = await output.save();
  } catch (error) {
    console.error("mergeChunkPdfs save failed", error);
    throw new Error(MERGE_ERROR_FAILED);
  }

  // Re-parse the saved bytes and confirm the page count survived
  // serialization (spec §16.4 step 7 "入出力ページ数一致を確認", §23's "出力
  // を再load可能"): a save() that produced bytes pdf-lib itself cannot load
  // back would otherwise reach xtctool undetected. This is the ONE
  // unavoidable re-parse (it validates `merged`, which nothing above has
  // read back yet) — callers must use its result (outputPages below) rather
  // than parsing `bytes` again themselves.
  let reloadedPages: number;
  try {
    const reloaded = await PDFDocument.load(merged, { updateMetadata: false });
    reloadedPages = reloaded.getPageCount();
  } catch (error) {
    console.error("mergeChunkPdfs reload-check failed", error);
    throw new Error(MERGE_ERROR_FAILED);
  }
  if (reloadedPages !== expectedPages) {
    throw new Error(MERGE_ERROR_PAGE_MISMATCH);
  }

  return { bytes: merged, inputPageCounts, outputPages: reloadedPages };
}

/** Sum of every chunk's byte length, for the pre-merge size gate (spec §17). */
export function totalBytes(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0);
}

/**
 * Page count of one PDF (used for the render-aozora-fallback-* per-chunk
 * diagnostic log, spec §21's "pageCount" field — the ONLY caller of this
 * function; the merge step gets every page count it needs directly off
 * mergeChunkPdfs' MergeChunkPdfsResult instead of calling this again, so a
 * chunk PDF is never parsed twice for the same purpose). Centralizes the
 * only other direct pdf-lib call this feature needs outside mergeChunkPdfs
 * itself, so src/workflow.ts never imports pdf-lib directly (spec §22's
 * module boundary). Throws MERGE_ERROR_FAILED on a chunk that fails to
 * parse — the same message a merge-time parse failure uses, since both mean
 * "this PDF is not usable".
 */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPageCount();
  } catch (error) {
    console.error("countPdfPages failed", error);
    throw new Error(MERGE_ERROR_FAILED);
  }
}
