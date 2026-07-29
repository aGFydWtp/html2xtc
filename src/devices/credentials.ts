// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { randomToken, sha256Hex, timingSafeEqual } from "../security/crypto";

/**
 * Device-token credential primitives (Phase2 spec §6.1 / §9 "token 生成と
 * ハッシュ化を pairings.ts 固有ロジックのままにしない。共通モジュールへ抽出する"):
 * every devices.token_hash in this system — whether the device row was
 * created by QR pairing approval (src/devices/pairings.ts's
 * approvePairingForAccount) or by manual OPDS device creation/rotation
 * (src/devices/service.ts) — is produced by exactly these functions, so the
 * byte length, algorithm, and comparison method can never silently drift
 * between the two call sites.
 *
 * Deliberately pure Web Crypto (crypto.getRandomValues/crypto.subtle via
 * src/security/crypto.ts) — no cloudflare:* import — same rationale as that
 * module's own doc comment.
 */

/** Device token size: 256 bits (plan §6.1 "token は最低32byte のランダム値"). */
const DEVICE_TOKEN_BYTES = 32;

export interface DeviceCredential {
  /** Plaintext token — returned to the caller exactly once (pairing poll response, or the manual-OPDS create/rotate response) and never persisted. */
  token: string;
  /** sha256Hex(token) — the only form persisted, in devices.token_hash. */
  tokenHash: string;
}

/** Generates a fresh, high-entropy device token: 256 bits, base64url-encoded (no padding). */
export function generateDeviceToken(): string {
  return randomToken(DEVICE_TOKEN_BYTES);
}

/** SHA-256 of a device token, as stored in devices.token_hash — no pepper (docs/security-model.md §4: deviceToken already carries 256 bits of entropy, unlike a user-chosen password). */
export function hashDeviceToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Timing-safe check of a caller-supplied plaintext token against a stored token_hash (used by BasicDeviceTokenAuthenticator, src/devices/authentication.ts). */
export async function verifyDeviceToken(token: string, tokenHash: string): Promise<boolean> {
  const candidateHash = await hashDeviceToken(token);
  return timingSafeEqual(candidateHash, tokenHash);
}

/**
 * Generates a token+hash pair in one call — the shape every device-credential
 * issuance site needs (QR pairing approval, manual OPDS device creation,
 * token rotation): a fresh plaintext token to hand back to the caller once,
 * and its hash to persist.
 */
export async function issueDeviceCredential(): Promise<DeviceCredential> {
  const token = generateDeviceToken();
  const tokenHash = await hashDeviceToken(token);
  return { token, tokenHash };
}
