// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { ConvertLayout } from "../types";
import type { AozoraFallbackChunkIndex } from "./keys";
import type { ContentMetrics } from "./metrics";

/** Per-chunk record embedded in AozoraFallbackManifest (spec §13). */
export interface AozoraFallbackManifestChunk extends ContentMetrics {
  index: AozoraFallbackChunkIndex;
  id: string;
  title?: string;
  htmlKey: string;
  pdfKey: string;
}

/**
 * Written by prepare-aozora-fallback (spec §12/§13/§16.2) once the 4 chunk
 * HTML documents are on R2; read back by the render-aozora-fallback-* and
 * merge-aozora-fallback-pdf steps so chunk order/keys are decided once, in
 * one place, and every downstream step re-reads the same decision instead of
 * re-deriving it (matches the rest of this Workflow's re-read-from-R2
 * design, src/workflow.ts's class doc comment).
 */
export interface AozoraFallbackManifest {
  version: 1;
  strategy: "four-balanced-dom-chunks";
  jobId: string;
  sourceUrl: string;
  title?: string;
  author?: string;
  layout: ConvertLayout;
  font: string;
  chunkCount: 4;
  totalTextLength: number;
  createdAt: string;
  chunks: AozoraFallbackManifestChunk[];
}

export function serializeAozoraFallbackManifest(manifest: AozoraFallbackManifest): string {
  return JSON.stringify(manifest);
}

/** Parses a stored manifest; null on anything malformed (defense in depth —
 * this service wrote it, but a partial/corrupted R2 read must not throw a
 * raw JSON.parse/shape error into the merge step). */
export function parseAozoraFallbackManifest(json: string): AozoraFallbackManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const manifest = parsed as Partial<AozoraFallbackManifest>;
  if (
    manifest.version !== 1 ||
    manifest.strategy !== "four-balanced-dom-chunks" ||
    typeof manifest.jobId !== "string" ||
    typeof manifest.sourceUrl !== "string" ||
    manifest.chunkCount !== 4 ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length !== 4
  ) {
    return null;
  }
  return manifest as AozoraFallbackManifest;
}
