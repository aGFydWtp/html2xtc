// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * R2 key layout for the Aozora catalog sync's intermediate artifacts. All of
 * them live under a single per-run prefix so the whole set can be swept in
 * cleanup, and so the existing 24h R2 lifecycle rule reclaims anything a
 * failed run leaves behind. Kept in one module (no cloudflare:* imports) so
 * the key shape stays unit-testable under plain vitest.
 */

/** Prefix that groups every intermediate object for one sync run. */
export function catalogSyncPrefix(runId: string): string {
  return `aozora-sync/${runId}`;
}

/** R2 key for the downloaded source ZIP of a run. */
export function catalogSourceZipKey(runId: string): string {
  return `${catalogSyncPrefix(runId)}/source.zip`;
}

/** R2 key for one book chunk (zero-padded so listings sort naturally). */
export function catalogBookChunkKey(runId: string, index: number): string {
  return `${catalogSyncPrefix(runId)}/books/${index
    .toString()
    .padStart(4, "0")}.json`;
}

/** R2 key for one contributor chunk. */
export function catalogContributorChunkKey(
  runId: string,
  index: number,
): string {
  return `${catalogSyncPrefix(runId)}/contributors/${index
    .toString()
    .padStart(4, "0")}.json`;
}
