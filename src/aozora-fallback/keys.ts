// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * R2 key layout for the Aozora timeout-fallback's own intermediates (spec
 * §12). All under intermediate/{jobId}/aozora-fallback/, sharing the
 * intermediate/ prefix's 1-day R2 lifecycle rule with article.html/
 * fonts.css/source.pdf (src/jobs.ts) — no separate lifecycle rule needed.
 * The merged PDF itself is NOT a key here: it is written to the existing
 * intermediatePdfKey(jobId) ("source.pdf"), so convert-xtc needs no changes
 * (spec §16.5/§20).
 */

const CHUNK_COUNT = 4;

/** 0..CHUNK_COUNT-1 — the only valid chunk indices for this fallback. */
export type AozoraFallbackChunkIndex = 0 | 1 | 2 | 3;

export function isAozoraFallbackChunkIndex(value: number): value is AozoraFallbackChunkIndex {
  return Number.isInteger(value) && value >= 0 && value < CHUNK_COUNT;
}

function fallbackPrefix(jobId: string): string {
  return `intermediate/${jobId}/aozora-fallback`;
}

export function aozoraFallbackManifestKey(jobId: string): string {
  return `${fallbackPrefix(jobId)}/manifest.json`;
}

export function aozoraFallbackProgressKey(jobId: string): string {
  return `${fallbackPrefix(jobId)}/progress.json`;
}

/** Zero-padded 4-digit chunk id, e.g. "0000" — matches manifest/R2 key naming (spec §12). */
export function aozoraFallbackChunkId(index: AozoraFallbackChunkIndex): string {
  return String(index).padStart(4, "0");
}

export function aozoraFallbackChunkHtmlKey(jobId: string, index: AozoraFallbackChunkIndex): string {
  return `${fallbackPrefix(jobId)}/chunks/${aozoraFallbackChunkId(index)}.html`;
}

export function aozoraFallbackChunkPdfKey(jobId: string, index: AozoraFallbackChunkIndex): string {
  return `${fallbackPrefix(jobId)}/chunks/${aozoraFallbackChunkId(index)}.pdf`;
}

/** Every R2 key this fallback can produce for one job, for best-effort cleanup (spec §16.6). */
export function allAozoraFallbackKeys(jobId: string): string[] {
  const keys = [aozoraFallbackManifestKey(jobId), aozoraFallbackProgressKey(jobId)];
  for (let index = 0; index < CHUNK_COUNT; index++) {
    keys.push(
      aozoraFallbackChunkHtmlKey(jobId, index as AozoraFallbackChunkIndex),
      aozoraFallbackChunkPdfKey(jobId, index as AozoraFallbackChunkIndex),
    );
  }
  return keys;
}
