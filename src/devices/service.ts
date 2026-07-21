// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Account } from "../auth/sessions";
import { isValidItemId } from "../library/service";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import {
  countAccountOwnedItems,
  getDeviceById,
  incrementDeviceLibraryVersion,
  listDeviceLibraryItems,
  listDevicesForAccount,
  replaceDeviceLibraryEntries,
  revokeDeviceRow,
  updateDeviceName,
} from "./repository";
import type { DeviceLibraryEntry, DeviceRecord } from "./repository";

/**
 * Service layer for the Phase 3 device-management API (plan §9.3) and the
 * Phase 4 per-device library API (plan §7.2 / §9.3). src/devices/routes.ts
 * is the thin HTTP adapter over this module, mirroring
 * src/library/service.ts + src/library/routes.ts.
 */

const MAX_DEVICE_NAME_LENGTH = 100;

/** Same sanitization shape as src/library/service.ts's sanitizeText / src/auth/webauthn.ts's sanitizeDisplayName. */
function sanitizeDeviceName(value: string): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH);
}

export interface DeviceDto {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  lastSeenAt: string | null;
}

function toDeviceDto(device: DeviceRecord): DeviceDto {
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

async function requireOwnedDevice(
  env: Pick<Env, "APP_DB">,
  account: Account,
  deviceId: string,
): Promise<DeviceRecord> {
  const device = await getDeviceById(env.APP_DB, account.id, deviceId);
  if (device === null) {
    throw Errors.notFound("DEVICE_NOT_FOUND", "device not found");
  }
  return device;
}

/** GET /api/devices. */
export async function listDevices(env: Pick<Env, "APP_DB">, account: Account): Promise<DeviceDto[]> {
  const devices = await listDevicesForAccount(env.APP_DB, account.id);
  return devices.map(toDeviceDto);
}

/** PATCH /api/devices/:deviceId — name only. */
export async function renameDevice(
  env: Pick<Env, "APP_DB">,
  account: Account,
  deviceId: string,
  rawName: string,
): Promise<DeviceDto> {
  const name = sanitizeDeviceName(rawName);
  if (name.length === 0) {
    throw Errors.badRequest("INVALID_DEVICE_NAME", "name must not be empty");
  }
  const updatedAt = new Date().toISOString();
  const changed = await updateDeviceName(env.APP_DB, account.id, deviceId, name, updatedAt);
  if (!changed) {
    throw Errors.notFound("DEVICE_NOT_FOUND", "device not found");
  }
  const device = await requireOwnedDevice(env, account, deviceId);
  return toDeviceDto(device);
}

/**
 * DELETE /api/devices/:deviceId (plan §9.3): flips status to 'revoked',
 * never a physical delete. Idempotent — revoking an already-revoked device
 * is treated as success rather than a conflict, since the end state the
 * caller wants ("this device can no longer authenticate") already holds.
 */
export async function revokeDevice(env: Pick<Env, "APP_DB">, account: Account, deviceId: string): Promise<void> {
  const device = await requireOwnedDevice(env, account, deviceId);
  if (device.status === "revoked") {
    return;
  }
  await revokeDeviceRow(env.APP_DB, account.id, deviceId, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Phase 4: per-device library assignment (plan §7.2 / §9.3)
// ---------------------------------------------------------------------------

export interface DeviceLibraryItemDto {
  id: string;
  title: string;
  author: string | null;
  sizeBytes: number;
  position: number;
  addedAt: string;
}

export interface DeviceLibraryDto {
  version: number;
  items: DeviceLibraryItemDto[];
}

/** GET /api/devices/:deviceId/library. */
export async function getDeviceLibrary(
  env: Pick<Env, "APP_DB">,
  account: Account,
  deviceId: string,
): Promise<DeviceLibraryDto> {
  const device = await requireOwnedDevice(env, account, deviceId);
  const items = await listDeviceLibraryItems(env.APP_DB, deviceId);
  return { version: device.libraryVersion, items };
}

/** Pure conflict check, hoisted out of replaceDeviceLibrary so it's directly unit-testable (plan §18.1 "expectedVersion競合" / "version判定"). Throws 409 VERSION_CONFLICT on mismatch. */
export function checkVersionMatch(currentVersion: number, expectedVersion: number): void {
  if (currentVersion !== expectedVersion) {
    throw Errors.conflict("VERSION_CONFLICT", "device library was modified concurrently");
  }
}

/**
 * Pure shape validation for the PUT device-library body's itemIds, hoisted
 * out of replaceDeviceLibrary for direct unit testing: rejects a non-array,
 * a non-string element, a duplicate id, or a non-UUID id. Ownership
 * (account scoping, plan §16 "他アカウントの...混入拒否") and existence
 * (soft-delete, plan §9.4 "削除済み(deleted_at)itemは拒否") both need D1 and
 * stay in replaceDeviceLibrary itself.
 */
export function validateItemIdsShape(itemIds: unknown): string[] {
  if (!Array.isArray(itemIds) || itemIds.some((id) => typeof id !== "string")) {
    throw Errors.badRequest("INVALID_ITEM_IDS", "itemIds must be an array of strings");
  }
  const typed = itemIds as string[];
  const unique = new Set(typed);
  if (unique.size !== typed.length) {
    throw Errors.badRequest("DUPLICATE_ITEM_ID", "itemIds must not contain duplicates");
  }
  for (const itemId of typed) {
    if (!isValidItemId(itemId)) {
      throw Errors.badRequest("INVALID_ITEM_ID", "itemIds must be UUIDs");
    }
  }
  return typed;
}

/**
 * Builds the 0-based-position device_library_items rows from an ordered
 * itemIds list (plan §7.2 step 4 "positionを0から連番で再登録") — pure, so
 * the position/order logic is directly unit-testable without D1 (plan
 * §18.1 "配信リストの順序").
 */
export function buildDeviceLibraryEntries(itemIds: string[], addedAt: string): DeviceLibraryEntry[] {
  return itemIds.map((libraryItemId, position) => ({ libraryItemId, position, addedAt }));
}

export interface ReplaceDeviceLibraryRequest {
  expectedVersion: number;
  itemIds: string[];
}

/**
 * PUT /api/devices/:deviceId/library (plan §7.2): validates the request,
 * then performs the optimistic-lock version check as its own conditional
 * UPDATE (incrementDeviceLibraryVersion) *before* touching
 * device_library_items. That ordering matters: D1's batch() has no way to
 * make a later statement conditional on an earlier statement's affected-row
 * count, so bundling the version guard into the same batch as the
 * delete+insert would let a losing writer's delete+insert still land even
 * though its version check "failed" underneath it. Running the guard as its
 * own awaited call first — and only proceeding to the delete+insert batch
 * once it reports success — is the same shape as the conditional-UPDATE
 * lock pattern in src/catalog-db.ts.
 */
export async function replaceDeviceLibrary(
  env: Pick<Env, "APP_DB">,
  account: Account,
  deviceId: string,
  request: ReplaceDeviceLibraryRequest,
): Promise<DeviceLibraryDto> {
  const device = await requireOwnedDevice(env, account, deviceId);
  if (device.status !== "active") {
    // A revoked device can never authenticate to fetch its OPDS feed again,
    // so editing its delivery list is a no-op the UI shouldn't offer —
    // same "revoked means frozen" rule as revokeDevice enforces.
    throw Errors.conflict("DEVICE_REVOKED", "device is revoked");
  }

  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    throw Errors.badRequest("INVALID_VERSION", "expectedVersion must be a positive integer");
  }
  const itemIds = validateItemIdsShape(request.itemIds);

  checkVersionMatch(device.libraryVersion, request.expectedVersion);

  if (itemIds.length > 0) {
    const ownedCount = await countAccountOwnedItems(env.APP_DB, account.id, itemIds);
    if (ownedCount !== itemIds.length) {
      throw Errors.forbidden("ITEM_NOT_OWNED", "one or more items are not in your library");
    }
  }

  const nowIso = new Date().toISOString();
  const versionMatched = await incrementDeviceLibraryVersion(
    env.APP_DB,
    account.id,
    deviceId,
    request.expectedVersion,
    nowIso,
  );
  if (!versionMatched) {
    // Lost the race between the checkVersionMatch read above and this write.
    throw Errors.conflict("VERSION_CONFLICT", "device library was modified concurrently");
  }

  const entries = buildDeviceLibraryEntries(itemIds, nowIso);
  await replaceDeviceLibraryEntries(env.APP_DB, deviceId, entries);

  const items = await listDeviceLibraryItems(env.APP_DB, deviceId);
  return { version: request.expectedVersion + 1, items };
}
