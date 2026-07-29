// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { resolveDeviceProfile } from "./devices";
import type { DeviceId } from "./devices";
import { decodeTitleHeader, outputXtcKey } from "./jobs";
import type { Env } from "./types";

/**
 * Reads the converted XTC body + title header from a successful converter
 * response and writes the final artifact to R2. Shared by the sync /convert
 * path (src/index.ts) and the async Workflow (src/workflow.ts) so the
 * title/metadata handling — and therefore the download filename — stays
 * identical across both. Callers must pass an ok (2xx) converter response.
 *
 * `device` is the Xteink device this specific job was actually converted
 * for — every caller has already resolved a concrete DeviceId by this point
 * (URL/TXT/EPUB via their own device/textOptions.device/epubOptions.device,
 * PDF-upload via pdfOptions.device). It rides along as R2 customMetadata
 * (device id + width/height) so a later library save (src/library/storage.ts's
 * copyToLibraryStorage) can record which device this exact XTC was produced
 * for — see migrations/app/0005_library_item_device.sql's doc comment for
 * why width/height are stored as their own immutable fields rather than
 * re-derived from the device id at read time. IMPORTANT: width/height below
 * come from resolveDeviceProfile's static table (src/devices.ts), NOT from
 * measuring what the Container actually produced — their correctness
 * depends entirely on src/devices.ts staying in sync with the converter's
 * own config-x3.toml/config-x4.toml (two sources of truth, kept in sync
 * manually, not derived from one another).
 */
export async function storeXtcOutput(
  env: Pick<Env, "XTC_BUCKET">,
  jobId: string,
  converterResponse: Response,
  device: DeviceId,
): Promise<{ title?: string }> {
  const title = decodeTitleHeader(converterResponse.headers.get("X-Xtc-Title"));
  const xtcBytes = await converterResponse.arrayBuffer();
  const profile = resolveDeviceProfile(device);
  await env.XTC_BUCKET.put(outputXtcKey(jobId), xtcBytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    // The download handler reads the title back from here for the
    // Content-Disposition filename; copyToLibraryStorage reads all four
    // fields back for a from-job library save.
    customMetadata: {
      ...(title !== undefined ? { title } : {}),
      device: profile.id,
      width: String(profile.outputWidthPx),
      height: String(profile.outputHeightPx),
    },
  });
  return { title };
}
