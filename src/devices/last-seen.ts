// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { touchDeviceLastSeen } from "./repository";

/**
 * Throttle for devices.last_seen_at updates on OPDS fetch / download success
 * (plan §10.4 "毎回D1を書き込まないよう、一定時間以内の更新は省略する"). The
 * pure decision (shouldUpdateLastSeen) is unit-testable without D1 (plan
 * §18.1 "last_seen_atスキップ判定"); touchLastSeenIfStale is the thin D1
 * wrapper the OPDS routes call.
 */

/** Minimum gap between last_seen_at writes: 5 minutes (plan §10.4). */
export const LAST_SEEN_UPDATE_THROTTLE_MS = 5 * 60 * 1000;

/**
 * True when last_seen_at should be refreshed: always on a device's very
 * first sighting (lastSeenAt === null), otherwise only once at least
 * throttleMs has elapsed since the last recorded update.
 */
export function shouldUpdateLastSeen(
  lastSeenAt: string | null,
  nowIso: string,
  throttleMs: number = LAST_SEEN_UPDATE_THROTTLE_MS,
): boolean {
  if (lastSeenAt === null) {
    return true;
  }
  return new Date(nowIso).getTime() - new Date(lastSeenAt).getTime() >= throttleMs;
}

/**
 * Writes devices.last_seen_at iff shouldUpdateLastSeen says the previous
 * value is stale enough — otherwise this is a no-op that never touches D1
 * (the whole point: OPDS polling every few seconds must not turn into a D1
 * write on every single request).
 */
export async function touchLastSeenIfStale(
  db: D1Database,
  device: { deviceId: string; lastSeenAt: string | null },
  nowIso: string,
): Promise<void> {
  if (!shouldUpdateLastSeen(device.lastSeenAt, nowIso)) {
    return;
  }
  await touchDeviceLastSeen(db, device.deviceId, nowIso);
}
