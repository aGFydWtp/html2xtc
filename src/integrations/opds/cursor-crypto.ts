// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { base64UrlDecode, base64UrlEncode } from "../../security/crypto";
import type { Env } from "../../types";

/**
 * Opaque, encrypted "cursor" tokens (spec §11.1): every OPDS href a client
 * needs to act on (a navigation subsection, a search template, a next/
 * previous page, an EPUB acquisition link) is encrypted into one of these
 * instead of ever being returned as a plain URL. The payload embeds enough
 * context (accountId/connectionId/kind/depth/expiry) that a cursor is
 * self-validating: decryptOpdsCursor alone can reject a forged, stale,
 * cross-account, or wrong-kind cursor without a DB round trip (the caller
 * still separately confirms the connectionId still exists — spec §11.1's
 * "接続削除後は利用不可" — since a deleted connection's id simply won't be
 * found by src/integrations/opds/repository.ts).
 *
 * Format: base64url(iv(12) || AES-256-GCM(iv, JSON(payload))). No AAD here
 * (unlike connection-crypto.ts) — the payload itself already carries every
 * field a cross-context replay would need to be checked against, and GCM's
 * own tag already detects tampering; a fixed "kind of thing this is"
 * constant would add no discriminating power an attacker could exploit,
 * since the payload's own `v`/`kind` fields serve that role at the
 * plaintext-shape level once decrypted.
 */

const AES_GCM_IV_BYTES = 12;
const CURSOR_KEY_BYTES = 32;
const CURSOR_TTL_SECONDS = 15 * 60; // spec §11.1 "有効期限15分"
export const MAX_OPDS_CURSOR_DEPTH = 10; // spec §11.1 "最大depth 10"

export type OpdsCursorKind = "navigation" | "search" | "acquisition_epub" | "next" | "previous";

const CURSOR_KINDS: ReadonlySet<OpdsCursorKind> = new Set<OpdsCursorKind>([
  "navigation",
  "search",
  "acquisition_epub",
  "next",
  "previous",
]);

export interface OpdsCursorPayload {
  v: 1;
  accountId: string;
  connectionId: string;
  kind: OpdsCursorKind;
  /** Absolute external URL — never sent back to the client except inside this encrypted token. */
  url: string;
  depth: number;
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Imports OPDS_CURSOR_ENCRYPTION_KEY (base64-encoded 256-bit key) as a non-extractable AES-GCM CryptoKey. Throws on missing/malformed/wrong-length key — same fail-loud stance as resolveOpdsConnectionEncryptionKey. */
export async function resolveOpdsCursorEncryptionKey(
  env: Pick<Env, "OPDS_CURSOR_ENCRYPTION_KEY">,
): Promise<CryptoKey> {
  if (env.OPDS_CURSOR_ENCRYPTION_KEY === undefined || env.OPDS_CURSOR_ENCRYPTION_KEY.length === 0) {
    throw new Error("OPDS_CURSOR_ENCRYPTION_KEY is not configured");
  }
  let raw: Uint8Array;
  try {
    raw = base64Decode(env.OPDS_CURSOR_ENCRYPTION_KEY);
  } catch {
    throw new Error("OPDS_CURSOR_ENCRYPTION_KEY is not valid base64");
  }
  if (raw.length !== CURSOR_KEY_BYTES) {
    throw new Error(`OPDS_CURSOR_ENCRYPTION_KEY must decode to ${CURSOR_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface EncryptOpdsCursorInput {
  accountId: string;
  connectionId: string;
  kind: OpdsCursorKind;
  url: string;
  depth: number;
}

/**
 * Encrypts a fresh cursor. Throws (a plain Error — this is a programmer-error
 * guard, not a user-facing condition: every call site computes `depth` from
 * a validated parent depth) if `depth` is negative or exceeds
 * MAX_OPDS_CURSOR_DEPTH; callers that reach the depth cap are expected to
 * omit that particular next/previous/subsection link from the response
 * entirely rather than call this at all (src/integrations/opds/service.ts).
 */
export async function encryptOpdsCursor(
  env: Pick<Env, "OPDS_CURSOR_ENCRYPTION_KEY">,
  input: EncryptOpdsCursorInput,
): Promise<string> {
  if (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > MAX_OPDS_CURSOR_DEPTH) {
    throw new Error(`encryptOpdsCursor: depth ${input.depth} out of range [0, ${MAX_OPDS_CURSOR_DEPTH}]`);
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: OpdsCursorPayload = {
    v: 1,
    accountId: input.accountId,
    connectionId: input.connectionId,
    kind: input.kind,
    url: input.url,
    depth: input.depth,
    issuedAt,
    expiresAt: issuedAt + CURSOR_TTL_SECONDS,
  };

  const key = await resolveOpdsCursorEncryptionKey(env);
  const iv = new Uint8Array(AES_GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return base64UrlEncode(combined);
}

export type DecryptOpdsCursorResult =
  | { ok: true; payload: OpdsCursorPayload }
  | { ok: false; reason: string };

function isValidCursorShape(value: unknown): value is OpdsCursorPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.accountId === "string" &&
    typeof v.connectionId === "string" &&
    typeof v.kind === "string" &&
    CURSOR_KINDS.has(v.kind as OpdsCursorKind) &&
    typeof v.url === "string" &&
    typeof v.depth === "number" &&
    Number.isInteger(v.depth) &&
    v.depth >= 0 &&
    v.depth <= MAX_OPDS_CURSOR_DEPTH &&
    typeof v.issuedAt === "number" &&
    typeof v.expiresAt === "number"
  );
}

/**
 * Decrypts and shape/expiry-validates a cursor token. Never throws — every
 * failure (malformed base64, wrong key, tampered GCM tag, malformed JSON,
 * bad shape, expired) comes back as `{ ok: false, reason }` so route
 * handlers can turn it into a uniform OPDS_CURSOR_INVALID 400 without a
 * try/catch. The caller is still responsible for checking
 * payload.accountId/connectionId/kind against the current request's own
 * values — this function only confirms the token is well-formed and not
 * expired.
 */
export async function decryptOpdsCursor(
  env: Pick<Env, "OPDS_CURSOR_ENCRYPTION_KEY">,
  token: string,
): Promise<DecryptOpdsCursorResult> {
  let combined: Uint8Array;
  try {
    combined = base64UrlDecode(token);
  } catch {
    return { ok: false, reason: "malformed cursor" };
  }
  if (combined.length <= AES_GCM_IV_BYTES) {
    return { ok: false, reason: "malformed cursor" };
  }
  const iv = combined.slice(0, AES_GCM_IV_BYTES);
  const ciphertext = combined.slice(AES_GCM_IV_BYTES);

  // A misconfigured OPDS_CURSOR_ENCRYPTION_KEY is a server-side
  // misconfiguration, not a client error — resolveOpdsCursorEncryptionKey's
  // throw propagates out of this function (not caught here) so the route
  // surfaces a 500 instead of a misleading "your cursor is invalid".
  const key = await resolveOpdsCursorEncryptionKey(env);

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    return { ok: false, reason: "cursor tampered or invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintextBuffer));
  } catch {
    return { ok: false, reason: "malformed cursor payload" };
  }
  if (!isValidCursorShape(parsed)) {
    return { ok: false, reason: "malformed cursor payload" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (parsed.expiresAt < nowSeconds) {
    return { ok: false, reason: "cursor expired" };
  }

  return { ok: true, payload: parsed };
}
