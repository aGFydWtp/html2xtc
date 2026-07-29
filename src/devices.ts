// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Single source of truth for the physical/geometric constants that differ
 * between Xteink DEVICE MODELS (X3, X4 — the hardware a conversion targets).
 * Distinct from src/devices/ (a directory, not this file): that module is
 * the account's paired-device DOMAIN (pairing, last-seen, library sync) —
 * an unrelated "device" concept that happens to share the English word.
 * Before this module existed the same numbers
 * were hardcoded independently in src/pdf.ts (the @page mm size for the URL/
 * PDF render paths), src/text-html.ts (the fixed CSS-px @page size for the
 * TXT-upload reading layout) and src/printhtml.ts (the image srcset target
 * width for extract-mode/Aozora documents) — every caller below now derives
 * those numbers from exactly one DeviceProfile.
 */

export type DeviceId = "x3" | "x4";

export interface DeviceProfile {
  readonly id: DeviceId;
  /** Output raster resolution in px — the XTC image's pixel dimensions, and
   * the fixed @page size (CSS px) the TXT-upload reading layout uses. */
  readonly outputWidthPx: number;
  readonly outputHeightPx: number;
  /** @page size, in mm, for the URL/PDF-extract render paths (src/pdf.ts). */
  readonly pageWidthMm: number;
  readonly pageHeightMm: number;
  /** @page margin, in mm, uniform on all four sides. */
  readonly marginMm: number;
  /** Target width (px) used to pick a srcset candidate for extracted
   * article images (src/printhtml.ts's pickFromSrcset). */
  readonly imageTargetWidthPx: number;
}

const X3_PROFILE: DeviceProfile = {
  id: "x3",
  outputWidthPx: 528,
  outputHeightPx: 792,
  pageWidthMm: 66,
  pageHeightMm: 99,
  marginMm: 4,
  imageTargetWidthPx: 528,
};

// px/mm is deliberately kept identical to the X3 (8) rather than derived
// from the X4's own physical panel ratio: matching the X3's px/mm keeps the
// on-page VISUAL SCALE of text identical across devices (a 10pt body line
// occupies the same fraction of the page width on both), which matters more
// here than exactly matching the X4 panel's native DPI.
const X4_PROFILE: DeviceProfile = {
  id: "x4",
  outputWidthPx: 480,
  outputHeightPx: 800,
  pageWidthMm: 60,
  pageHeightMm: 100,
  marginMm: 4,
  imageTargetWidthPx: 480,
};

export const DEVICE_PROFILES: Readonly<Record<DeviceId, DeviceProfile>> = {
  x3: X3_PROFILE,
  x4: X4_PROFILE,
};

/** Default/fallback device — see resolveDeviceId's doc comment for why this
 * must never change without an explicit, deliberate migration. */
export const DEFAULT_DEVICE_ID: DeviceId = "x3";
export const DEFAULT_DEVICE_PROFILE: DeviceProfile = X3_PROFILE;

export function isDeviceId(value: unknown): value is DeviceId {
  return value === "x3" || value === "x4";
}

/**
 * Fail-soft device resolution for the URL/Workflow paths (mirrors
 * resolveRenderOptions's stance in src/sitepresets.ts): any value other than
 * exactly "x3"/"x4" — including undefined, wrong type, or an unrecognized
 * string — resolves to "x3". This is a deliberate compatibility guarantee:
 * every request/stored job param that predates the `device` field (or
 * merely omits it) must keep rendering byte-identical X3 output.
 */
export function resolveDeviceId(value: unknown): DeviceId {
  return isDeviceId(value) ? value : DEFAULT_DEVICE_ID;
}

export function resolveDeviceProfile(value: unknown): DeviceProfile {
  return DEVICE_PROFILES[resolveDeviceId(value)];
}
