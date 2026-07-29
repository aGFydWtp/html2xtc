// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { DEFAULT_DEVICE_ID, DEVICE_PROFILES, isDeviceId } from "../devices";
import type { DeviceId } from "../devices";
import type { Env } from "../types";

/**
 * R2 access for the persistent library: key layout (plan §8.1) and the
 * streamed copy from a source R2 key (a finished job's output.xtc) into the
 * per-account, per-item library/ key. Kept separate from src/jobs.ts, whose
 * R2 keys live under the auto-expiring intermediate/ and jobs/ prefixes —
 * library/ must NOT be covered by that lifecycle rule (see
 * claudedocs/deploy-guide.md and the implementation plan §8.1).
 */

/**
 * Recovers {device, width, height} from a source object's customMetadata
 * (written by storeXtcOutput, src/pipeline.ts). Absent/garbled metadata
 * means the XTC predates device tracking (X4 didn't exist yet) — every
 * conversion before that point was physically X3 (528x792,
 * converter/config-x3.toml alone), so defaulting to the X3 profile here is
 * a factual backfill, not a guess (mirrors migrations/app/0005_library_item_device.sql's
 * own column defaults). width/height are read from the stored metadata
 * verbatim rather than re-derived from `device` at this read time — see
 * that migration's doc comment for why device profiles must never be
 * treated as a mutable reference for an already-recorded row.
 */
function parseDeviceMetadata(
  customMetadata: Record<string, string> | undefined,
): { device: DeviceId; width: number; height: number } {
  const rawDevice = customMetadata?.device;
  const device = isDeviceId(rawDevice) ? rawDevice : DEFAULT_DEVICE_ID;
  const fallback = DEVICE_PROFILES[device];
  const rawWidth = Number(customMetadata?.width);
  const rawHeight = Number(customMetadata?.height);
  const width = Number.isInteger(rawWidth) && rawWidth > 0 ? rawWidth : fallback.outputWidthPx;
  const height = Number.isInteger(rawHeight) && rawHeight > 0 ? rawHeight : fallback.outputHeightPx;
  return { device, width, height };
}

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
  /** Target device this XTC was actually converted for (see parseDeviceMetadata above). */
  device: DeviceId;
  /**
   * Output px width/height as recorded by storeXtcOutput (src/pipeline.ts)
   * from src/devices.ts's static profile table — NOT a measurement of the
   * converter's actual output (see parseDeviceMetadata above, and
   * src/library/repository.ts's LibraryItem.width/height for the full
   * two-sources-of-truth caveat).
   */
  width: number;
  height: number;
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
  const { device, width, height } = parseDeviceMetadata(source.customMetadata);
  return {
    key,
    sizeBytes: source.size,
    sha256: source.customMetadata?.sha256 ?? null,
    title: source.customMetadata?.title ?? null,
    device,
    width,
    height,
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
