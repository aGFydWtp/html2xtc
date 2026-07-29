// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "../../types";

/**
 * AES-256-GCM field encryption for opds_connections' credential columns
 * (catalog_url / username / password — spec §11). Modeled directly on
 * src/security/aes-gcm.ts's PAIRING_ENCRYPTION_KEY helpers (same IV/tag
 * sizes, same non-extractable-CryptoKey / standard-base64-32-byte-key
 * shape), but adds Additional Authenticated Data binding each ciphertext to
 * the exact (accountId, connectionId, field) triple it was encrypted for
 * (spec §11: "暗号文を別アカウント・別接続・別フィールドへ移しても復号できない
 * ようにする") — aes-gcm.ts's pairing use case has no such cross-row-reuse
 * risk (a device token is single-use, deleted on ack), so AAD wasn't needed
 * there. Pure Web Crypto — no cloudflare:* import — so this stays
 * unit-testable under plain vitest (test/opds-connection-crypto.test.ts).
 */

const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const CONNECTION_KEY_BYTES = 32;

export type OpdsConnectionField = "catalog_url" | "username" | "password";

export interface OpdsConnectionFieldContext {
  accountId: string;
  connectionId: string;
  field: OpdsConnectionField;
}

export interface EncryptedOpdsField {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

/** Decodes a standard (non-url) base64 string to raw bytes. Throws (via atob) on malformed input. */
function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildAad(context: OpdsConnectionFieldContext): Uint8Array {
  return new TextEncoder().encode(
    `html2xtc:opds-connection:v1:${context.accountId}:${context.connectionId}:${context.field}`,
  );
}

/**
 * Imports OPDS_CONNECTION_ENCRYPTION_KEY (base64-encoded 256-bit key) as a
 * non-extractable AES-GCM CryptoKey. Throws if the secret is unset, isn't
 * valid base64, or doesn't decode to exactly 32 bytes — a misconfigured key
 * must fail loudly (fail-loud, not fail-open, since this guards a
 * confidentiality boundary) rather than silently encrypting/decrypting with
 * the wrong length.
 */
export async function resolveOpdsConnectionEncryptionKey(
  env: Pick<Env, "OPDS_CONNECTION_ENCRYPTION_KEY">,
): Promise<CryptoKey> {
  if (env.OPDS_CONNECTION_ENCRYPTION_KEY === undefined || env.OPDS_CONNECTION_ENCRYPTION_KEY.length === 0) {
    throw new Error("OPDS_CONNECTION_ENCRYPTION_KEY is not configured");
  }
  let raw: Uint8Array;
  try {
    raw = base64Decode(env.OPDS_CONNECTION_ENCRYPTION_KEY);
  } catch {
    throw new Error("OPDS_CONNECTION_ENCRYPTION_KEY is not valid base64");
  }
  if (raw.length !== CONNECTION_KEY_BYTES) {
    throw new Error(`OPDS_CONNECTION_ENCRYPTION_KEY must decode to ${CONNECTION_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts one credential field's plaintext, bound to `context` via AAD (spec §11). */
export async function encryptOpdsConnectionField(
  env: Pick<Env, "OPDS_CONNECTION_ENCRYPTION_KEY">,
  context: OpdsConnectionFieldContext,
  plaintext: string,
): Promise<EncryptedOpdsField> {
  const key = await resolveOpdsConnectionEncryptionKey(env);
  const iv = new Uint8Array(AES_GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const additionalData = buildAad(context);
  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return {
    ciphertext: combined.slice(0, combined.length - AES_GCM_TAG_BYTES),
    iv,
    authTag: combined.slice(combined.length - AES_GCM_TAG_BYTES),
  };
}

/**
 * Reverses encryptOpdsConnectionField. Throws (subtle.decrypt rejects) if
 * the key, iv, ciphertext, or tag don't match, OR if `context` doesn't match
 * the (accountId, connectionId, field) the ciphertext was originally
 * encrypted for — the AAD mismatch surfaces as the same decrypt failure, by
 * design (GCM gives no way to distinguish "wrong key" from "wrong AAD").
 */
export async function decryptOpdsConnectionField(
  env: Pick<Env, "OPDS_CONNECTION_ENCRYPTION_KEY">,
  context: OpdsConnectionFieldContext,
  payload: EncryptedOpdsField,
): Promise<string> {
  const key = await resolveOpdsConnectionEncryptionKey(env);
  const additionalData = buildAad(context);
  const combined = new Uint8Array(payload.ciphertext.length + payload.authTag.length);
  combined.set(payload.ciphertext, 0);
  combined.set(payload.authTag, payload.ciphertext.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: payload.iv, additionalData },
    key,
    combined,
  );
  return new TextDecoder().decode(plaintext);
}

/** Copies a Uint8Array's exact bytes into a fresh ArrayBuffer, safe to bind to a D1 BLOB column even when the view is a subarray of a larger buffer (mirrors src/auth/repository.ts's toArrayBuffer). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
