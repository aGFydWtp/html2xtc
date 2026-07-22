// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { resolveWebauthnOrigin } from "../auth/webauthn";
import type { Account } from "../auth/sessions";
import { resolveMaxDevicesPerAccount } from "../quotas";
import { decryptWithPairingKey, encryptWithPairingKey } from "../security/aes-gcm";
import { logAuditEvent } from "../security/audit";
import { randomToken, sha256Hex, timingSafeEqual } from "../security/crypto";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import {
  approvePairingRow,
  completePairingRow,
  countActiveDevices,
  getPairingById,
  getPairingByUserCode,
  hardDeleteDevice,
  insertDevice,
  insertPairing,
  rejectPairingRow,
} from "./repository";
import type { PairingRecord } from "./repository";

/**
 * Business logic for the Phase 3 pairing flow (plan §6 / §9.4): the
 * unauthenticated device-facing endpoints (start/poll/complete) and the
 * Cookie-authenticated web endpoints (lookup-by-code/approve/reject).
 * src/devices/routes.ts is the thin HTTP adapter over this module, mirroring
 * src/auth/webauthn.ts + src/auth/routes.ts.
 */

// ---------------------------------------------------------------------------
// userCode: generation + normalization (pure — plan §18.1 "userCodeの正規化")
// ---------------------------------------------------------------------------

/** 32 chars: A-Z and 2-9, excluding O/0 and I/1 (plan §6 "視認しやすい文字のみ使用" / "O/0、I/1等は除外"). */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;

/**
 * Generates a fresh "XXXX-XXXX" pairing code. 32 chars is a power of two, so
 * masking a uniform random byte to its low 5 bits (`& 0x1f`) selects an
 * alphabet index with no modulo bias.
 */
export function generateUserCode(): string {
  const bytes = new Uint8Array(USER_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const byte of bytes) {
    raw += USER_CODE_ALPHABET[byte & 0x1f];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Normalizes user-typed input (case-insensitive, hyphen optional per plan
 * §6 "大文字小文字を区別しない") to the canonical "XXXX-XXXX" form used as
 * the unique lookup key, or null if it isn't a well-formed code — including
 * when it contains an excluded-but-plausible character (o/0/i/1), which is
 * treated the same as "not found" rather than specially reported (plan §9.4
 * "存在しなくても404の情報を最小に").
 */
export function normalizeUserCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (stripped.length !== USER_CODE_LENGTH) {
    return null;
  }
  for (const char of stripped) {
    if (!USER_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

// ---------------------------------------------------------------------------
// pairing status transitions (pure — plan §18.1 "pending/approved/rejected/completedの遷移")
// ---------------------------------------------------------------------------

export type PairingStatus = "pending" | "approved" | "rejected" | "completed" | "expired";

export interface PairingStatusInput {
  status: string;
  expiresAt: string;
}

/**
 * Virtualizes a still-'pending' row past its expiresAt as "expired" without
 * requiring a background sweep to have written that literal status yet (the
 * plan's cleanup step — §6 step 7 — is best-effort and deferred to Phase 7).
 * Every other stored status passes through unchanged: once a pairing leaves
 * 'pending' (approved/rejected/completed) it no longer expires through this
 * function — plan §6 doesn't gate those states on expiresAt.
 */
export function decidePairingStatus(row: PairingStatusInput, nowMs: number): PairingStatus {
  if (row.status === "pending" && new Date(row.expiresAt).getTime() <= nowMs) {
    return "expired";
  }
  return row.status as PairingStatus;
}

export function isPairingApprovable(row: PairingStatusInput, nowMs: number): boolean {
  return decidePairingStatus(row, nowMs) === "pending";
}

export function isPairingRejectable(row: PairingStatusInput, nowMs: number): boolean {
  return decidePairingStatus(row, nowMs) === "pending";
}

export function isPairingCompletable(row: PairingStatusInput, nowMs: number): boolean {
  return decidePairingStatus(row, nowMs) === "approved";
}

// ---------------------------------------------------------------------------
// Authorization: Pairing <secret> header (pure)
// ---------------------------------------------------------------------------

const PAIRING_AUTH_PREFIX = "Pairing ";

/** Extracts the pairingSecret from `Authorization: Pairing <secret>` (plan §9.4). Returns null for a missing/wrong-scheme header or a blank secret. */
export function parsePairingSecretHeader(header: string | null): string | null {
  if (header === null || !header.startsWith(PAIRING_AUTH_PREFIX)) {
    return null;
  }
  const secret = header.slice(PAIRING_AUTH_PREFIX.length).trim();
  return secret.length > 0 ? secret : null;
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_POLL_INTERVAL_SECONDS = 5;
const PAIRING_SECRET_BYTES = 32;
const DEVICE_TOKEN_BYTES = 32;
const MAX_USER_CODE_GENERATION_ATTEMPTS = 10;
const MAX_REQUESTED_NAME_LENGTH = 100;
const MAX_DEVICE_NAME_LENGTH = 100;

/** Same sanitization shape as src/library/service.ts's sanitizeText / src/auth/webauthn.ts's sanitizeDisplayName. */
function sanitizeFreeText(value: string, maxLength: number): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export interface StartPairingResult {
  pairingId: string;
  pairingSecret: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

/**
 * POST /api/device-pairings (plan §6.1 / §9.4): unauthenticated, called by
 * the Xteink device itself. Generates the pairingId/pairingSecret/userCode,
 * persists a 'pending' row (only the secret's hash), and returns everything
 * the device needs to display a QR code and start polling.
 */
export async function startPairing(
  env: Pick<Env, "APP_DB" | "WEBAUTHN_ORIGIN">,
  requestedName: string | null,
): Promise<StartPairingResult> {
  // The per-IP "ペアリング開始 | IP | 20回/時" rate limit (plan §13) is
  // enforced by the caller (src/devices/routes.ts's POST
  // /api/device-pairings handler) before this function is ever invoked —
  // it needs the raw Request, which this function deliberately doesn't
  // take, to key the limiter by IP.
  const origin = resolveWebauthnOrigin(env);
  const sanitizedName =
    requestedName !== null ? sanitizeFreeText(requestedName, MAX_REQUESTED_NAME_LENGTH) : null;

  const pairingId = crypto.randomUUID();
  const pairingSecret = randomToken(PAIRING_SECRET_BYTES);
  const pairingSecretHash = await sha256Hex(pairingSecret);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);

  let userCode: string | null = null;
  for (let attempt = 0; attempt < MAX_USER_CODE_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generateUserCode();
    try {
      await insertPairing(env.APP_DB, {
        id: pairingId,
        userCode: candidate,
        pairingSecretHash,
        requestedName: sanitizedName !== null && sanitizedName.length > 0 ? sanitizedName : null,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      userCode = candidate;
      break;
    } catch (error) {
      // Unique constraint on user_code: astronomically unlikely with a
      // 32-char alphabet ^8, but retry with a fresh code rather than fail
      // the whole pairing attempt over a code collision.
      console.error("pairing insert collided on user_code, retrying", error);
    }
  }
  if (userCode === null) {
    throw Errors.internal("failed to allocate a pairing code");
  }

  return {
    pairingId,
    pairingSecret,
    userCode,
    verificationUri: `${origin}/?pair=${encodeURIComponent(userCode)}`,
    expiresAt: expiresAt.toISOString(),
    pollIntervalSeconds: PAIRING_POLL_INTERVAL_SECONDS,
  };
}

/** Verifies pairingSecret against pairing.pairingSecretHash with a timing-safe comparison. Throws UNAUTHORIZED on mismatch. */
async function verifyPairingSecret(pairing: PairingRecord, pairingSecret: string): Promise<void> {
  const providedHash = await sha256Hex(pairingSecret);
  if (!timingSafeEqual(providedHash, pairing.pairingSecretHash)) {
    throw Errors.unauthorized("invalid pairing secret");
  }
}

export type PairingPollResult =
  | { status: "pending" | "rejected" | "completed" | "expired" }
  | { status: "approved"; deviceId: string; deviceToken: string };

/**
 * GET /api/device-pairings/:pairingId (plan §9.4): device-side polling.
 * Only an 'approved' pairing returns device credentials — everything else
 * returns just its status. Decrypts the AES-GCM payload with
 * PAIRING_ENCRYPTION_KEY (plan §6 step 5).
 */
export async function pollPairing(
  env: Pick<Env, "APP_DB" | "PAIRING_ENCRYPTION_KEY">,
  pairingId: string,
  pairingSecret: string,
): Promise<PairingPollResult> {
  const pairing = await getPairingById(env.APP_DB, pairingId);
  if (pairing === null) {
    throw Errors.notFound("PAIRING_NOT_FOUND", "pairing not found");
  }
  await verifyPairingSecret(pairing, pairingSecret);

  const status = decidePairingStatus(pairing, Date.now());
  if (status !== "approved") {
    return { status };
  }

  if (pairing.deviceId === null || pairing.encryptedDeviceToken === null || pairing.tokenIv === null || pairing.tokenAuthTag === null) {
    // Unreachable in normal operation: an 'approved' row always has these
    // set together by approvePairingForAccount below. Fail loudly rather
    // than return a confusing partial response.
    throw Errors.internal("pairing is approved but missing device credentials");
  }

  const deviceToken = await decryptWithPairingKey(env, {
    ciphertext: pairing.encryptedDeviceToken,
    iv: pairing.tokenIv,
    authTag: pairing.tokenAuthTag,
  });

  return { status: "approved", deviceId: pairing.deviceId, deviceToken };
}

/**
 * POST /api/device-pairings/:pairingId/complete (plan §6 step 6 / §9.4):
 * device-side acknowledgment. Only valid from 'approved' — deletes the
 * encrypted token material and marks the pairing 'completed'.
 */
export async function completePairingByDevice(
  env: Pick<Env, "APP_DB">,
  pairingId: string,
  pairingSecret: string,
): Promise<void> {
  const pairing = await getPairingById(env.APP_DB, pairingId);
  if (pairing === null) {
    throw Errors.notFound("PAIRING_NOT_FOUND", "pairing not found");
  }
  await verifyPairingSecret(pairing, pairingSecret);

  if (!isPairingCompletable(pairing, Date.now())) {
    throw Errors.conflict("PAIRING_NOT_APPROVED", "pairing is not in an approved state");
  }
  const completed = await completePairingRow(env.APP_DB, pairingId, new Date().toISOString());
  if (!completed) {
    // Lost a race (e.g. a concurrent complete() already ran).
    throw Errors.conflict("PAIRING_NOT_APPROVED", "pairing is not in an approved state");
  }
}

export interface PairingLookupDto {
  pairingId: string;
  requestedName: string | null;
  expiresAt: string;
}

/**
 * GET /api/pairings/by-code/:userCode (plan §9.4): web-side lookup by the
 * code the user read off the device's screen. Only a currently-pending
 * pairing is returned; an invalid code, an unknown code, or one that has
 * moved past pending (approved/rejected/completed/expired) all produce the
 * same 404 (plan §9.4 "存在しなくても404の情報を最小に").
 */
export async function findPairingByCode(
  env: Pick<Env, "APP_DB">,
  rawUserCode: string,
): Promise<PairingLookupDto> {
  const normalized = normalizeUserCode(rawUserCode);
  if (normalized === null) {
    throw Errors.notFound("PAIRING_NOT_FOUND", "pairing not found");
  }
  const pairing = await getPairingByUserCode(env.APP_DB, normalized);
  if (pairing === null || decidePairingStatus(pairing, Date.now()) !== "pending") {
    throw Errors.notFound("PAIRING_NOT_FOUND", "pairing not found");
  }
  return { pairingId: pairing.id, requestedName: pairing.requestedName, expiresAt: pairing.expiresAt };
}

export interface ApprovedDeviceDto {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

/**
 * POST /api/pairings/:pairingId/approve (plan §6 / §9.4): creates the
 * device row, encrypts a fresh deviceToken for the polling device to pick
 * up, and atomically flips the pairing to 'approved' — conditional on it
 * still being pending and unexpired (approvePairingRow), so a double
 * approval (or an approval racing a reject/expiry) can only ever succeed
 * once (plan §18.1 "二重承認防止"). If that guard loses the race, the
 * just-created device row is rolled back rather than left orphaned.
 */
export async function approvePairingForAccount(
  env: Pick<Env, "APP_DB" | "PAIRING_ENCRYPTION_KEY" | "MAX_DEVICES_PER_ACCOUNT">,
  account: Account,
  pairingId: string,
  rawName: string,
): Promise<ApprovedDeviceDto> {
  const name = sanitizeFreeText(rawName, MAX_DEVICE_NAME_LENGTH);
  if (name.length === 0) {
    throw Errors.badRequest("INVALID_DEVICE_NAME", "name is required");
  }

  const pairing = await getPairingById(env.APP_DB, pairingId);
  if (pairing === null || !isPairingApprovable(pairing, Date.now())) {
    throw Errors.conflict("PAIRING_NOT_PENDING", "pairing is not pending");
  }

  // Device-count quota (登録モード仕様 Phase1 §5.3): checked before creating
  // the device row so a rejection never leaves a pairing half-approved.
  const activeDeviceCount = await countActiveDevices(env.APP_DB, account.id);
  if (activeDeviceCount >= resolveMaxDevicesPerAccount(env)) {
    logAuditEvent("account.quota.exceeded", { accountId: account.id, quota: "devices" });
    throw Errors.conflict("DEVICE_LIMIT_EXCEEDED", "device limit reached");
  }

  const deviceId = crypto.randomUUID();
  const deviceToken = randomToken(DEVICE_TOKEN_BYTES);
  const tokenHash = await sha256Hex(deviceToken);
  const nowIso = new Date().toISOString();

  await insertDevice(env.APP_DB, {
    id: deviceId,
    accountId: account.id,
    name,
    tokenHash,
    createdAt: nowIso,
  });

  const encrypted = await encryptWithPairingKey(env, deviceToken);
  const approved = await approvePairingRow(env.APP_DB, pairingId, {
    accountId: account.id,
    deviceId,
    encryptedDeviceToken: encrypted.ciphertext,
    tokenIv: encrypted.iv,
    tokenAuthTag: encrypted.authTag,
    approvedAt: nowIso,
  });

  if (!approved) {
    // Lost a race against a concurrent approve/reject/expiry: the device row
    // we just created has no pairing pointing at it and never will, so
    // remove it rather than leave an account with an orphaned device.
    await hardDeleteDevice(env.APP_DB, deviceId);
    throw Errors.conflict("PAIRING_NOT_PENDING", "pairing is not pending");
  }

  return { id: deviceId, name, status: "active", createdAt: nowIso };
}

/** POST /api/pairings/:pairingId/reject (plan §9.4). Conditional on still-pending, same double-check shape as approve. */
export async function rejectPairingForAccount(env: Pick<Env, "APP_DB">, pairingId: string): Promise<void> {
  const pairing = await getPairingById(env.APP_DB, pairingId);
  if (pairing === null || !isPairingRejectable(pairing, Date.now())) {
    throw Errors.conflict("PAIRING_NOT_PENDING", "pairing is not pending");
  }
  const rejected = await rejectPairingRow(env.APP_DB, pairingId, new Date().toISOString());
  if (!rejected) {
    throw Errors.conflict("PAIRING_NOT_PENDING", "pairing is not pending");
  }
}
