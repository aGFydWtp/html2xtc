// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { aozoraFallbackProgressKey } from "./keys";
import type { AozoraFallbackChunkIndex } from "./keys";

/**
 * Fallback-internal progress record (spec §18's "任意"). Deliberately NOT
 * wired into GET /jobs/:id — the public JobStatusBody (src/jobs.ts) has no
 * field for it and adding one would need frontend changes with no existing
 * consumer, so this stays a diagnostic-only R2 object read only by manual
 * inspection (e.g. a support engineer probing R2 during rollout). The public
 * job status keeps returning the existing queued/rendering/converting/
 * completed/failed values unchanged throughout the fallback (spec §18).
 */
export interface AozoraFallbackProgress {
  version: 1;
  fallbackTriggered: true;
  phase: "splitting" | "rendering" | "merging" | "converting";
  completedChunks: number;
  totalChunks: 4;
  currentChunkIndex?: AozoraFallbackChunkIndex;
  updatedAt: string;
}

/**
 * Best-effort progress write: swallows every R2 error, matching this
 * service's existing stance on non-essential R2 writes (e.g. source.pdf in
 * src/index.ts's handleConvert — "a diagnostic artifact; the conversion
 * doesn't depend on it, so log and continue"). Never awaited for its
 * side-effect on the job outcome — a failed write must not fail the job.
 */
export async function writeAozoraFallbackProgress(
  env: { XTC_BUCKET: { put(key: string, value: string, options?: unknown): Promise<unknown> } },
  jobId: string,
  progress: Omit<AozoraFallbackProgress, "version" | "fallbackTriggered" | "totalChunks" | "updatedAt">,
): Promise<void> {
  const body: AozoraFallbackProgress = {
    version: 1,
    fallbackTriggered: true,
    totalChunks: 4,
    updatedAt: new Date().toISOString(),
    ...progress,
  };
  try {
    await env.XTC_BUCKET.put(aozoraFallbackProgressKey(jobId), JSON.stringify(body), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (error) {
    console.error(`[${jobId}] best-effort aozora fallback progress write failed`, error);
  }
}
