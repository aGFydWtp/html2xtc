// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "../types";

/**
 * AES-GCM helpers for the pairing flow's one-time device-token handoff
 * (plan §6 "認証情報の受け渡し"): a freshly generated deviceToken is never
 * persisted raw — it is encrypted with PAIRING_ENCRYPTION_KEY and the
 * ciphertext/iv/tag are stored on device_pairings until the device retrieves
 * and acknowledges it (POST .../complete deletes them, src/devices/pairings.ts).
 * Pure Web Crypto (crypto.subtle) — no cloudflare:* import — so the
 * encrypt/decrypt round-trip is directly unit-testable under plain vitest
 * (see test/security-aes-gcm.test.ts), same rationale as src/security/crypto.ts.
 */

const AES_GCM_IV_BYTES = 12; // 96-bit nonce, the size AES-GCM is designed for.
const AES_GCM_TAG_BYTES = 16; // 128-bit authentication tag (WebCrypto's default).
const PAIRING_KEY_BYTES = 32; // 256-bit key, per plan §12 "base64の256bit鍵".

export interface EncryptedPayload {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

/**
 * Decodes a standard (non-url) base64 string to raw bytes.
 * PAIRING_ENCRYPTION_KEY is plain base64 per plan §12 — distinct from the
 * base64url tokens used elsewhere (src/security/crypto.ts's randomToken).
 * Throws (via atob) on malformed input.
 */
function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Imports PAIRING_ENCRYPTION_KEY (base64-encoded 256-bit key) as a
 * non-extractable AES-GCM CryptoKey. Throws if the secret is unset, isn't
 * valid base64, or doesn't decode to exactly 32 bytes — a misconfigured key
 * must fail loudly rather than silently encrypt/decrypt with the wrong
 * length.
 */
export async function resolvePairingEncryptionKey(
  env: Pick<Env, "PAIRING_ENCRYPTION_KEY">,
): Promise<CryptoKey> {
  if (env.PAIRING_ENCRYPTION_KEY === undefined || env.PAIRING_ENCRYPTION_KEY.length === 0) {
    throw new Error("PAIRING_ENCRYPTION_KEY is not configured");
  }
  let raw: Uint8Array;
  try {
    raw = base64Decode(env.PAIRING_ENCRYPTION_KEY);
  } catch {
    throw new Error("PAIRING_ENCRYPTION_KEY is not valid base64");
  }
  if (raw.length !== PAIRING_KEY_BYTES) {
    throw new Error(`PAIRING_ENCRYPTION_KEY must decode to ${PAIRING_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts `plaintext` (the raw deviceToken) with a fresh random IV.
 * WebCrypto's AES-GCM output is ciphertext with the 16-byte auth tag
 * appended; this splits that back into the three columns the schema stores
 * separately (device_pairings.encrypted_device_token / token_iv /
 * token_auth_tag, plan §7.1) — decryptWithPairingKey re-concatenates them in
 * the same order before calling subtle.decrypt.
 */
export async function encryptWithPairingKey(
  env: Pick<Env, "PAIRING_ENCRYPTION_KEY">,
  plaintext: string,
): Promise<EncryptedPayload> {
  const key = await resolvePairingEncryptionKey(env);
  const iv = new Uint8Array(AES_GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const combined = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return {
    ciphertext: combined.slice(0, combined.length - AES_GCM_TAG_BYTES),
    iv,
    authTag: combined.slice(combined.length - AES_GCM_TAG_BYTES),
  };
}

/**
 * Reverses encryptWithPairingKey. Throws (subtle.decrypt rejects) if the
 * key, iv, ciphertext, or tag don't match what was originally encrypted —
 * e.g. a tampered row or the wrong PAIRING_ENCRYPTION_KEY.
 */
export async function decryptWithPairingKey(
  env: Pick<Env, "PAIRING_ENCRYPTION_KEY">,
  payload: EncryptedPayload,
): Promise<string> {
  const key = await resolvePairingEncryptionKey(env);
  const combined = new Uint8Array(payload.ciphertext.length + payload.authTag.length);
  combined.set(payload.ciphertext, 0);
  combined.set(payload.authTag, payload.ciphertext.length);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.iv }, key, combined);
  return new TextDecoder().decode(plaintext);
}
