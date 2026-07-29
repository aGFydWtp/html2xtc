// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { isDeviceId } from "../devices";
import type { DeviceId } from "../devices";

/**
 * Normalizes the device model/resolution a Xteink device self-reports on
 * POST /api/device-pairings (migrations/app/0006_pairing_declared_device.sql).
 * Pure and fail-soft by design: this is called from an unauthenticated,
 * device-facing endpoint, and a malformed/unexpected value here must never
 * fail the pairing itself — it only ever degrades to "unknown" (null), never
 * to a 400. Never falls back to resolveDeviceId's "assume x3" behavior
 * (src/devices.ts): that fallback exists to keep legacy render requests
 * byte-identical, but here guessing x3 for an unrecognized/future model would
 * misrecord the device and suppress a real future "wrong device" warning.
 */

export interface DeclaredDeviceInput {
  deviceModel?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface DeclaredDevice {
  device: DeviceId | null;
  width: number | null;
  height: number | null;
}

/** Generous upper bound for a self-reported resolution — just enough to reject garbage/overflow-bait, not a real device limit. */
const MAX_DECLARED_DIMENSION_PX = 10_000;

function normalizeDeclaredDimension(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_DECLARED_DIMENSION_PX
    ? value
    : null;
}

/**
 * device is normalized independently of width/height (an unknown model with
 * a valid resolution still records the resolution). width/height are an
 * all-or-nothing pair — a lone dimension can't be compared against anything,
 * so a defect in either nulls both rather than recording a half resolution.
 */
export function normalizeDeclaredDevice(input: DeclaredDeviceInput): DeclaredDevice {
  const device = typeof input.deviceModel === "string" && isDeviceId(input.deviceModel) ? input.deviceModel : null;

  const width = normalizeDeclaredDimension(input.width);
  const height = normalizeDeclaredDimension(input.height);
  const resolution = width !== null && height !== null ? { width, height } : { width: null, height: null };

  return { device, width: resolution.width, height: resolution.height };
}
