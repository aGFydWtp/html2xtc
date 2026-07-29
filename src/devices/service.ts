// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Account } from "../auth/sessions";
import type { DeviceId } from "../devices";
import { DEVICE_PROFILES } from "../devices";
import { isValidItemId } from "../library/service";
import { resolveMaxDevicesPerAccount } from "../quotas";
import { logAuditEvent } from "../security/audit";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import { issueDeviceCredential } from "./credentials";
import {
  countAccountOwnedItems,
  countActiveDevices,
  getDeviceById,
  incrementDeviceLibraryVersion,
  insertDevice,
  listDeviceLibraryItems,
  listDevicesForAccount,
  replaceDeviceLibraryEntries,
  revokeDeviceRow,
  updateDeviceName,
  updateDeviceTokenHash,
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
  /** Machine-declared model/resolution from pairing (migrations/app/0006_pairing_declared_device.sql); null for a device paired before this field existed, or by a firmware that never declared one. Foundation for a future "you're about to send an X4 file to an X3" warning — the comparison must use width/height, not device, per that migration's rationale. */
  device: string | null;
  width: number | null;
  height: number | null;
  /** 'pairing' | 'manual_opds' (migrations/app/0007_device_registration_method.sql). Never token/tokenHash — see this module's createManualOpdsDevice/rotateDeviceToken doc comments for where the plaintext token is returned instead. */
  registrationMethod: string;
}

function toDeviceDto(device: DeviceRecord): DeviceDto {
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    device: device.device,
    width: device.width,
    height: device.height,
    registrationMethod: device.registrationMethod,
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
// Manual OPDS device registration (Phase2 spec §8.1 / §8.2): lets a standard
// OPDS client (e.g. stock CrossPoint) be registered from the WebUI without
// the device-initiated QR pairing flow. Once created, a manual_opds device
// is indistinguishable from a paired one to every other code path (auth,
// OPDS, library assignment, revoke) — registrationMethod is descriptive
// only (spec §7).
// ---------------------------------------------------------------------------

/** Generous upper bound for a user-supplied custom resolution — same value as src/devices/declared-device.ts's MAX_DECLARED_DIMENSION_PX (that one is fail-soft for a device-declared value; this one 400s instead, since it's an authenticated user's own explicit input). */
const MAX_MANUAL_DIMENSION_PX = 10_000;

function isValidManualDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_MANUAL_DIMENSION_PX;
}

const MANUAL_DEVICE_MODELS = ["x3", "x4", "other"] as const;
type ManualDeviceModel = (typeof MANUAL_DEVICE_MODELS)[number];

function isManualDeviceModel(value: unknown): value is ManualDeviceModel {
  return typeof value === "string" && (MANUAL_DEVICE_MODELS as readonly string[]).includes(value);
}

export interface ResolvedManualDeviceProfile {
  device: DeviceId | null;
  width: number | null;
  height: number | null;
}

/**
 * Pure validation/normalization for the manual-OPDS-device creation body's
 * deviceModel/width/height (Phase2 spec §8.1), hoisted out of
 * createManualOpdsDevice for direct unit testing:
 *
 * - deviceModel must be omitted/null, "x3", "x4", or "other" — anything else
 *   is 400 INVALID_DEVICE_MODEL.
 * - "x3"/"x4": width/height are always the DEVICE_PROFILES preset — a
 *   client-supplied width/height is silently ignored (spec §8.1 "クライアント
 *   値を無条件に信用しない"), never validated, never a 400.
 * - "other" (or omitted): width/height must either both be omitted (→ null,
 *   null — "resolution unknown", same semantics as the pairing-declared
 *   device columns) or both be positive integers up to 10000; anything else
 *   (only one given, non-integer, zero, negative, too large) is 400
 *   INVALID_DEVICE_RESOLUTION.
 */
export function resolveManualDeviceProfile(
  deviceModel: unknown,
  width: unknown,
  height: unknown,
): ResolvedManualDeviceProfile {
  if (deviceModel !== undefined && deviceModel !== null && !isManualDeviceModel(deviceModel)) {
    throw Errors.badRequest("INVALID_DEVICE_MODEL", "deviceModel must be x3, x4, other, or omitted");
  }
  if (deviceModel === "x3" || deviceModel === "x4") {
    const profile = DEVICE_PROFILES[deviceModel];
    return { device: deviceModel, width: profile.outputWidthPx, height: profile.outputHeightPx };
  }

  const widthOmitted = width === undefined || width === null;
  const heightOmitted = height === undefined || height === null;
  if (widthOmitted && heightOmitted) {
    return { device: null, width: null, height: null };
  }
  if (!isValidManualDimension(width) || !isValidManualDimension(height)) {
    throw Errors.badRequest(
      "INVALID_DEVICE_RESOLUTION",
      "width and height must both be positive integers (up to 10000), or both omitted",
    );
  }
  return { device: null, width, height };
}

export interface CreateManualOpdsDeviceRequest {
  /** Already confirmed to be a string by the route (src/devices/routes.ts) — mirrors approvePairingForAccount's rawName parameter (src/devices/pairings.ts). */
  name: string;
  deviceModel: unknown;
  width: unknown;
  height: unknown;
}

export interface DeviceCredentialResult {
  device: DeviceDto;
  /** Plaintext device token — returned to the route for the one-time OPDS-credentials response body. Never logged, never re-derivable from the DTO above. */
  token: string;
}

/**
 * POST /api/devices/manual-opds (Phase2 spec §8.1): validates name/model/
 * resolution, enforces the same device-count quota as QR pairing approval
 * (countActiveDevices + resolveMaxDevicesPerAccount, mirroring
 * approvePairingForAccount in src/devices/pairings.ts), then issues a fresh
 * device credential and inserts an already-active device row with
 * registrationMethod='manual_opds'. Device library starts empty — insertDevice
 * never touches device_library_items.
 */
export async function createManualOpdsDevice(
  env: Pick<Env, "APP_DB" | "MAX_DEVICES_PER_ACCOUNT">,
  account: Account,
  request: CreateManualOpdsDeviceRequest,
): Promise<DeviceCredentialResult> {
  const name = sanitizeDeviceName(request.name);
  if (name.length === 0) {
    throw Errors.badRequest("INVALID_DEVICE_NAME", "name is required");
  }

  const { device, width, height } = resolveManualDeviceProfile(request.deviceModel, request.width, request.height);

  // Device-count quota (Phase2 spec §8.1 requirement 1), same rule/error
  // shape as approvePairingForAccount (src/devices/pairings.ts).
  const activeDeviceCount = await countActiveDevices(env.APP_DB, account.id);
  if (activeDeviceCount >= resolveMaxDevicesPerAccount(env)) {
    logAuditEvent("account.quota.exceeded", { accountId: account.id, quota: "devices" });
    throw Errors.conflict("DEVICE_LIMIT_EXCEEDED", "device limit reached");
  }

  const deviceId = crypto.randomUUID();
  const { token, tokenHash } = await issueDeviceCredential();
  const nowIso = new Date().toISOString();

  await insertDevice(env.APP_DB, {
    id: deviceId,
    accountId: account.id,
    name,
    tokenHash,
    createdAt: nowIso,
    device,
    width,
    height,
    registrationMethod: "manual_opds",
  });

  return {
    device: {
      id: deviceId,
      name,
      status: "active",
      createdAt: nowIso,
      lastSeenAt: null,
      device,
      width,
      height,
      registrationMethod: "manual_opds",
    },
    token,
  };
}

/**
 * POST /api/devices/:deviceId/rotate-token (Phase2 spec §8.2): the device
 * must be owned by the caller (requireOwnedDevice — a missing device and one
 * owned by another account both 404 identically) and currently 'active'
 * (revoked devices reject with 409 DEVICE_REVOKED, spec requirement 2). The
 * new token_hash is written by a single conditional UPDATE
 * (updateDeviceTokenHash) that re-checks status='active' at write time —
 * closing the race where the device is revoked between the check above and
 * this write — so the old token is invalidated at the exact moment the new
 * one is persisted (spec §12 "新旧 token の長時間併存は認めない"), never both
 * at once.
 */
export async function rotateDeviceToken(
  env: Pick<Env, "APP_DB">,
  account: Account,
  deviceId: string,
): Promise<DeviceCredentialResult> {
  const device = await requireOwnedDevice(env, account, deviceId);
  if (device.status !== "active") {
    throw Errors.conflict("DEVICE_REVOKED", "device is revoked");
  }

  const { token, tokenHash } = await issueDeviceCredential();
  const updatedAt = new Date().toISOString();
  const rotated = await updateDeviceTokenHash(env.APP_DB, account.id, deviceId, tokenHash, updatedAt);
  if (!rotated) {
    // Lost a race: the device was revoked between the check above and this write.
    throw Errors.conflict("DEVICE_REVOKED", "device is revoked");
  }

  return {
    device: toDeviceDto({ ...device, updatedAt }),
    token,
  };
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

/**
 * Best-effort auto-delivery: called only from src/library/routes.ts's
 * from-job handler, and only when saveJobToLibrary genuinely inserted a new
 * row (never on its idempotent-replay path — resurrecting an item a user
 * deliberately removed from a device's list would be surprising). If the
 * account currently has exactly one active device, prepends the new item to
 * the front of that device's delivery list, reusing replaceDeviceLibrary so
 * the version bump / optimistic-lock bookkeeping stays in one place. No-ops for
 * zero or multiple active devices, and for a device whose list already
 * contains the item (avoids a duplicate device_library_items PK).
 *
 * Never throws: any failure here (a lost version race, a device revoked in
 * the interim, a D1 error) must not turn a successful library save into an
 * error response — it's recorded via logAuditEvent instead of being
 * silently dropped.
 */
export async function autoAddItemToSoleActiveDevice(
  env: Pick<Env, "APP_DB">,
  account: Account,
  libraryItemId: string,
): Promise<void> {
  try {
    const devices = await listDevicesForAccount(env.APP_DB, account.id);
    if (devices.length !== 1) {
      return;
    }
    const device = devices[0];
    const library = await getDeviceLibrary(env, account, device.id);
    if (library.items.some((item) => item.id === libraryItemId)) {
      return;
    }
    const itemIds = [libraryItemId, ...library.items.map((item) => item.id)];
    const updated = await replaceDeviceLibrary(env, account, device.id, {
      expectedVersion: library.version,
      itemIds,
    });
    logAuditEvent("device.library.auto_added", {
      accountId: account.id,
      deviceId: device.id,
      itemId: libraryItemId,
      version: updated.version,
    });
  } catch (error) {
    console.error(`auto-add of library item ${libraryItemId} to the sole active device failed`, error);
    logAuditEvent("device.library.auto_add_failed", {
      accountId: account.id,
      itemId: libraryItemId,
    });
  }
}
