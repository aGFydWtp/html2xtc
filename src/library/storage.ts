// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "../types";

/**
 * R2 access for the persistent library: key layout (plan §8.1) and the
 * streamed copy from a source R2 key (a finished job's output.xtc) into the
 * per-account, per-item library/ key. Kept separate from src/jobs.ts, whose
 * R2 keys live under the auto-expiring intermediate/ and jobs/ prefixes —
 * library/ must NOT be covered by that lifecycle rule (see
 * claudedocs/deploy-guide.md and the implementation plan §8.1).
 */

/** R2 key for a permanently stored library item's XTC. */
export function libraryItemKey(accountId: string, itemId: string): string {
  return `library/accounts/${accountId}/items/${itemId}/book.xtc`;
}

export interface CopiedLibraryObject {
  key: string;
  sizeBytes: number;
  /** From the source object's customMetadata.sha256, when present (plan §8.3: nullable until the converter is changed to compute it). */
  sha256: string | null;
  /** From the source object's customMetadata.title (set by storeXtcOutput, src/pipeline.ts), used as the default library title. */
  title: string | null;
}

/**
 * Copies the R2 object at sourceKey into libraryItemKey(accountId, itemId).
 * The body is streamed straight from get() into put() — never buffered into
 * a Worker-side ArrayBuffer — so this scales to XTCs far larger than what
 * would be safe to hold in memory. Returns null if sourceKey doesn't exist
 * (the from-job caller maps this to a 404).
 */
export async function copyToLibraryStorage(
  env: Pick<Env, "XTC_BUCKET">,
  sourceKey: string,
  accountId: string,
  itemId: string,
): Promise<CopiedLibraryObject | null> {
  const source = await env.XTC_BUCKET.get(sourceKey);
  if (source === null) {
    return null;
  }
  const key = libraryItemKey(accountId, itemId);
  await env.XTC_BUCKET.put(key, source.body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: source.customMetadata,
  });
  return {
    key,
    sizeBytes: source.size,
    sha256: source.customMetadata?.sha256 ?? null,
    title: source.customMetadata?.title ?? null,
  };
}

/** Best-effort delete, used to roll back a completed R2 copy when the following D1 insert fails. Never throws. */
export async function deleteLibraryStorageBestEffort(
  env: Pick<Env, "XTC_BUCKET">,
  key: string,
): Promise<void> {
  try {
    await env.XTC_BUCKET.delete(key);
  } catch (error) {
    console.error(`best-effort delete of ${key} failed`, error);
  }
}
