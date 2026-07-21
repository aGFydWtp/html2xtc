// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * D1 access for devices, device_pairings, and device_library_items (plan
 * §7.1 / §9.3 / §9.4). Every devices/device_library_items query that isn't
 * explicitly "for auth" or "by pairing code" is scoped by account_id, so a
 * caller can never reach another account's device by guessing a deviceId
 * (plan §16 — the same principle src/library/repository.ts applies to
 * library_items). Row (snake_case) <-> app (camelCase) mapping follows the
 * existing convention (src/catalog-db.ts, src/auth/repository.ts).
 */

/** Copies a Uint8Array's exact bytes into a fresh ArrayBuffer, safe to bind to a D1 BLOB column even when the view is a subarray of a larger buffer (same helper as src/auth/repository.ts's private toArrayBuffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  id: string;
  accountId: string;
  name: string;
  status: string;
  libraryVersion: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface DeviceRow {
  id: string;
  account_id: string;
  name: string;
  status: string;
  library_version: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

function fromDeviceRow(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    status: row.status,
    libraryVersion: row.library_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

/** Never includes token_hash (plan §9.3 "token_hashは返さない") — every device read in this module goes through this column list. */
const DEVICE_COLUMNS =
  "id, account_id, name, status, library_version, created_at, updated_at, last_seen_at, revoked_at";

export interface NewDevice {
  id: string;
  accountId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
}

/** Inserts a new active device (status='active', library_version=1). Used by approvePairingForAccount (src/devices/pairings.ts). */
export async function insertDevice(db: D1Database, device: NewDevice): Promise<void> {
  await db
    .prepare(
      `INSERT INTO devices (id, account_id, name, token_hash, status, library_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
    )
    .bind(device.id, device.accountId, device.name, device.tokenHash, device.createdAt, device.createdAt)
    .run();
}

/** Physically removes a device row. Only called to roll back a device created moments earlier for a pairing approval that then lost its race against a concurrent approve/reject/expiry (src/devices/pairings.ts) — never exposed as a user-facing delete (see revokeDeviceRow for the real, soft "delete"). */
export async function hardDeleteDevice(db: D1Database, deviceId: string): Promise<void> {
  await db.prepare(`DELETE FROM devices WHERE id = ?`).bind(deviceId).run();
}

/** Fetches one device scoped to accountId; null if missing or owned by another account. */
export async function getDeviceById(
  db: D1Database,
  accountId: string,
  deviceId: string,
): Promise<DeviceRecord | null> {
  const row = await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ? AND account_id = ?`)
    .bind(deviceId, accountId)
    .first<DeviceRow>();
  return row === null ? null : fromDeviceRow(row);
}

/** Lists an account's devices, newest first. */
export async function listDevicesForAccount(db: D1Database, accountId: string): Promise<DeviceRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE account_id = ? ORDER BY created_at DESC`)
    .bind(accountId)
    .all<DeviceRow>();
  return results.map(fromDeviceRow);
}

/** Renames a device; returns false if not found/owned. */
export async function updateDeviceName(
  db: D1Database,
  accountId: string,
  deviceId: string,
  name: string,
  updatedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE devices SET name = ?, updated_at = ? WHERE id = ? AND account_id = ?`)
    .bind(name, updatedAt, deviceId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Revokes an active device (plan §9.3 "物理削除ではなく...status=revoked"): conditional on the current status being 'active' so re-revoking an already-revoked device is a no-op rather than clobbering the original revoked_at. */
export async function revokeDeviceRow(
  db: D1Database,
  accountId: string,
  deviceId: string,
  revokedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE devices SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE id = ? AND account_id = ? AND status = 'active'`,
    )
    .bind(revokedAt, revokedAt, deviceId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Replaces an active device's token hash (rotation invalidates the old token immediately, plan §9.3). Conditional on status='active' — a revoked device can't be reissued a token. */
export async function rotateDeviceTokenHash(
  db: D1Database,
  accountId: string,
  deviceId: string,
  newTokenHash: string,
  updatedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE devices SET token_hash = ?, updated_at = ?
       WHERE id = ? AND account_id = ? AND status = 'active'`,
    )
    .bind(newTokenHash, updatedAt, deviceId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Optimistic-lock guard for PUT device library (plan §7.2 steps 1/5):
 * increments library_version by exactly 1 iff it still equals
 * expectedVersion, mirroring the conditional-UPDATE lock pattern in
 * src/catalog-db.ts. Must run — and its result be checked — *before* any
 * device_library_items write, because D1's batch() has no way to make a
 * later statement conditional on an earlier statement's affected-row count;
 * see src/devices/service.ts's replaceDeviceLibrary for the full sequencing
 * rationale. Returns false if the device doesn't exist/isn't owned, or the
 * version had already moved (a concurrent PUT won the race).
 */
export async function incrementDeviceLibraryVersion(
  db: D1Database,
  accountId: string,
  deviceId: string,
  expectedVersion: number,
  updatedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE devices SET library_version = library_version + 1, updated_at = ?
       WHERE id = ? AND account_id = ? AND library_version = ?`,
    )
    .bind(updatedAt, deviceId, accountId, expectedVersion)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Device lookup for Basic-auth (src/devices/authentication.ts): unscoped by
 * design (the caller is authenticating *as* a device, not acting as an
 * already-known account) but still returns status so
 * BasicDeviceTokenAuthenticator can reject a revoked device by the same rule
 * as every other route (plan §16 "端末解除を即時反映する").
 */
export interface DeviceAuthRecord {
  id: string;
  accountId: string;
  name: string;
  tokenHash: string;
  status: string;
}

export async function getDeviceForAuth(db: D1Database, deviceId: string): Promise<DeviceAuthRecord | null> {
  const row = await db
    .prepare(`SELECT id, account_id, name, token_hash, status FROM devices WHERE id = ?`)
    .bind(deviceId)
    .first<{ id: string; account_id: string; name: string; token_hash: string; status: string }>();
  if (row === null) {
    return null;
  }
  return { id: row.id, accountId: row.account_id, name: row.name, tokenHash: row.token_hash, status: row.status };
}

// ---------------------------------------------------------------------------
// device_pairings
// ---------------------------------------------------------------------------

export interface PairingRecord {
  id: string;
  userCode: string;
  pairingSecretHash: string;
  requestedName: string | null;
  status: string;
  accountId: string | null;
  deviceId: string | null;
  encryptedDeviceToken: Uint8Array | null;
  tokenIv: Uint8Array | null;
  tokenAuthTag: Uint8Array | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  completedAt: string | null;
}

interface PairingRow {
  id: string;
  user_code: string;
  pairing_secret_hash: string;
  requested_name: string | null;
  status: string;
  account_id: string | null;
  device_id: string | null;
  encrypted_device_token: ArrayBuffer | null;
  token_iv: ArrayBuffer | null;
  token_auth_tag: ArrayBuffer | null;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  completed_at: string | null;
}

const PAIRING_COLUMNS =
  "id, user_code, pairing_secret_hash, requested_name, status, account_id, device_id, encrypted_device_token, token_iv, token_auth_tag, created_at, expires_at, approved_at, completed_at";

function fromPairingRow(row: PairingRow): PairingRecord {
  return {
    id: row.id,
    userCode: row.user_code,
    pairingSecretHash: row.pairing_secret_hash,
    requestedName: row.requested_name,
    status: row.status,
    accountId: row.account_id,
    deviceId: row.device_id,
    encryptedDeviceToken: row.encrypted_device_token !== null ? new Uint8Array(row.encrypted_device_token) : null,
    tokenIv: row.token_iv !== null ? new Uint8Array(row.token_iv) : null,
    tokenAuthTag: row.token_auth_tag !== null ? new Uint8Array(row.token_auth_tag) : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
  };
}

export interface NewPairing {
  id: string;
  userCode: string;
  pairingSecretHash: string;
  requestedName: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Inserts a new pending pairing. Throws (D1 UNIQUE violation on user_code) on collision — the caller (startPairing, src/devices/pairings.ts) retries with a fresh code. */
export async function insertPairing(db: D1Database, pairing: NewPairing): Promise<void> {
  await db
    .prepare(
      `INSERT INTO device_pairings (id, user_code, pairing_secret_hash, requested_name, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      pairing.id,
      pairing.userCode,
      pairing.pairingSecretHash,
      pairing.requestedName,
      pairing.createdAt,
      pairing.expiresAt,
    )
    .run();
}

export async function getPairingById(db: D1Database, pairingId: string): Promise<PairingRecord | null> {
  const row = await db
    .prepare(`SELECT ${PAIRING_COLUMNS} FROM device_pairings WHERE id = ?`)
    .bind(pairingId)
    .first<PairingRow>();
  return row === null ? null : fromPairingRow(row);
}

export async function getPairingByUserCode(db: D1Database, userCode: string): Promise<PairingRecord | null> {
  const row = await db
    .prepare(`SELECT ${PAIRING_COLUMNS} FROM device_pairings WHERE user_code = ?`)
    .bind(userCode)
    .first<PairingRow>();
  return row === null ? null : fromPairingRow(row);
}

export interface PairingApproval {
  accountId: string;
  deviceId: string;
  encryptedDeviceToken: Uint8Array;
  tokenIv: Uint8Array;
  tokenAuthTag: Uint8Array;
  approvedAt: string;
}

/** Conditional on status='pending' AND not yet expired — the same double-check pattern as consumeChallenge (src/auth/challenges.ts), closing the race between the caller's own isPairingApprovable check and this write (plan §18.1 "二重承認防止"). */
export async function approvePairingRow(
  db: D1Database,
  pairingId: string,
  approval: PairingApproval,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE device_pairings
       SET status = 'approved', account_id = ?, device_id = ?, encrypted_device_token = ?, token_iv = ?, token_auth_tag = ?, approved_at = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .bind(
      approval.accountId,
      approval.deviceId,
      toArrayBuffer(approval.encryptedDeviceToken),
      toArrayBuffer(approval.tokenIv),
      toArrayBuffer(approval.tokenAuthTag),
      approval.approvedAt,
      pairingId,
      approval.approvedAt,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Conditional on status='pending' AND not yet expired. */
export async function rejectPairingRow(db: D1Database, pairingId: string, nowIso: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE device_pairings SET status = 'rejected' WHERE id = ? AND status = 'pending' AND expires_at > ?`)
    .bind(pairingId, nowIso)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Conditional on status='approved'. Clears the encrypted token material (plan §6 step 6 "端末が完了通知を送ったら暗号文を削除"). */
export async function completePairingRow(db: D1Database, pairingId: string, completedAt: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE device_pairings
       SET status = 'completed', completed_at = ?, encrypted_device_token = NULL, token_iv = NULL, token_auth_tag = NULL
       WHERE id = ? AND status = 'approved'`,
    )
    .bind(completedAt, pairingId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// device_library_items
// ---------------------------------------------------------------------------

export interface DeviceLibraryItemRow {
  id: string;
  title: string;
  author: string | null;
  sizeBytes: number;
  position: number;
  addedAt: string;
}

/** Lists the items assigned to a device, joined with library_items for display fields; excludes soft-deleted items (plan §9.3/§10.3 — a deleted item disappears from every device's list without needing its device_library_items row cleaned up separately, mirroring how src/library/service.ts's deleteLibrary also calls removeItemFromAllDeviceLibraries as a belt-and-suspenders cleanup). */
export async function listDeviceLibraryItems(db: D1Database, deviceId: string): Promise<DeviceLibraryItemRow[]> {
  const { results } = await db
    .prepare(
      `SELECT li.id AS id, li.title AS title, li.author AS author, li.size_bytes AS size_bytes,
              dli.position AS position, dli.added_at AS added_at
       FROM device_library_items dli
       JOIN library_items li ON li.id = dli.library_item_id
       WHERE dli.device_id = ? AND li.deleted_at IS NULL
       ORDER BY dli.position ASC`,
    )
    .bind(deviceId)
    .all<{ id: string; title: string; author: string | null; size_bytes: number; position: number; added_at: string }>();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    author: row.author,
    sizeBytes: row.size_bytes,
    position: row.position,
    addedAt: row.added_at,
  }));
}

/**
 * Counts how many of itemIds belong to accountId and aren't soft-deleted —
 * used to reject cross-account or deleted items in one round trip (plan
 * §7.2 step 2 / §16). Returns 0 without querying when itemIds is empty (an
 * empty `IN ()` is invalid SQL, and "0 owned of 0 requested" is trivially
 * fine — an empty replacement list just clears the device's library).
 */
export async function countAccountOwnedItems(db: D1Database, accountId: string, itemIds: string[]): Promise<number> {
  if (itemIds.length === 0) {
    return 0;
  }
  const placeholders = itemIds.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM library_items
       WHERE account_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .bind(accountId, ...itemIds)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export interface DeviceLibraryEntry {
  libraryItemId: string;
  position: number;
  addedAt: string;
}

/**
 * Replaces a device's entire assignment list in one D1 batch call
 * (delete-all then re-insert with 0-based positions, plan §7.2 steps 3-4):
 * the batch's statements share one transaction, so a partial
 * delete-without-insert (or vice versa) can never be observed. This call is
 * NOT itself the concurrency guard — the caller (src/devices/service.ts)
 * must have already won the incrementDeviceLibraryVersion race before
 * calling this.
 */
export async function replaceDeviceLibraryEntries(
  db: D1Database,
  deviceId: string,
  entries: DeviceLibraryEntry[],
): Promise<void> {
  const statements = [
    db.prepare(`DELETE FROM device_library_items WHERE device_id = ?`).bind(deviceId),
    ...entries.map((entry) =>
      db
        .prepare(
          `INSERT INTO device_library_items (device_id, library_item_id, position, added_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(deviceId, entry.libraryItemId, entry.position, entry.addedAt),
    ),
  ];
  await db.batch(statements);
}
