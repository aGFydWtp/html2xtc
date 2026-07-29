// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "../../types";

/**
 * Opaque entry ids (spec §13.6): a feed's own `<id>` (and a publication
 * entry's `urn:uuid:...`) must never reach the browser verbatim — the
 * Memlane investigation (spec §7) found the feed-level and navigation-entry
 * `<id>` fields are literally the secret URL itself. This derives a
 * connection-scoped, one-way, non-reversible id instead: an HMAC-SHA-256 of
 * the source id keyed by OPDS_CURSOR_ENCRYPTION_KEY, with connectionId mixed
 * into the signed message, so (a) without the key an attacker who only sees
 * API responses cannot invert it back to the source id/URL, and (b) the same
 * source id hashes to a different opaque id per connection (no
 * cross-connection correlation). Truncated to 24 hex chars (96 bits) —
 * display/dedup-key use only, not itself a security boundary (the actual
 * secret is the hidden source id).
 *
 * HMAC, not a bare `sha256(secret || message)`: the latter is the classic
 * length-extension-vulnerable construction. Reuses OPDS_CURSOR_ENCRYPTION_KEY
 * rather than introducing a third secret — this is a distinct HMAC key
 * import (crypto.subtle.importKey with usage restricted to "sign"), not an
 * AES-GCM operation, so there is no key-reuse-across-algorithms concern the
 * way there would be for two encryption uses of the same raw key.
 */

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Imports OPDS_CURSOR_ENCRYPTION_KEY (the same base64-encoded 256-bit key cursor-crypto.ts uses for AES-GCM) as a non-extractable HMAC-SHA-256 CryptoKey, restricted to "sign" only (this module never verifies, only derives). */
async function importEntryIdHmacKey(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64Decode(secret);
  } catch {
    throw new Error("OPDS_CURSOR_ENCRYPTION_KEY is not valid base64");
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function opaqueOpdsEntryId(
  env: Pick<Env, "OPDS_CURSOR_ENCRYPTION_KEY">,
  connectionId: string,
  sourceId: string,
): Promise<string> {
  const secret = env.OPDS_CURSOR_ENCRYPTION_KEY;
  if (secret === undefined || secret.length === 0) {
    throw new Error("OPDS_CURSOR_ENCRYPTION_KEY is not configured");
  }
  const key = await importEntryIdHmacKey(secret);
  const message = new TextEncoder().encode(`html2xtc:opds-entry-id:v1:${connectionId}:${sourceId}`);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return toHex(signature).slice(0, 24);
}
