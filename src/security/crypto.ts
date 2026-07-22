// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { rateLimitKey } from "../ratelimit";

/**
 * Crypto primitives shared by sessions, device tokens, registration invites,
 * and pairing secrets: high-entropy token generation, SHA-256 hashing,
 * base64url encode/decode, and a timing-safe string comparison.
 *
 * Pure Web Crypto (crypto.getRandomValues, crypto.subtle, atob/btoa) — no
 * cloudflare:* import — so this module is directly unit-testable under plain
 * vitest (see test/security-crypto.test.ts), same rationale as
 * src/ratelimit.ts and src/jobs.ts. The one exception is the import of
 * rateLimitKey below (also cloudflare:*-free), reused for hashClientIp's
 * IPv6 normalization.
 */

/** Default token size: 256 bits, matching the plan's "32 bytes+" requirement for session/device/invite tokens. */
const DEFAULT_TOKEN_BYTES = 32;

/**
 * Generates a high-entropy random token from crypto.getRandomValues,
 * base64url-encoded (no padding). Used for session tokens, device tokens,
 * registration invite tokens, and pairing secrets.
 */
export function randomToken(byteLength: number = DEFAULT_TOKEN_BYTES): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** SHA-256 of a UTF-8 string or raw bytes, returned as lowercase hex. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Base64url-encodes raw bytes (RFC 4648 §5, no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes a base64url string (padding optional) back to raw bytes. Throws on malformed input. */
export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Hashes a client IP for registration_events.ip_hash (登録モード仕様 Phase2
 * §3/§4b): reuses rateLimitKey's IPv6 /64 normalization (src/ratelimit.ts)
 * so an entire subnet always hashes to the same value, then mixes in
 * REGISTRATION_IP_PEPPER before hashing — the same pepper-prefixed
 * sha256Hex pattern hashSessionToken uses (src/auth/sessions.ts). Returns
 * null when there's no IP to hash — rateLimitKey's null case (local dev, or
 * an edge that stripped CF-Connecting-IP), never reachable from the real
 * Cloudflare edge in production.
 */
export async function hashClientIp(ip: string | null, pepper: string): Promise<string | null> {
  const normalized = rateLimitKey(ip);
  if (normalized === null) {
    return null;
  }
  return sha256Hex(`${pepper}:${normalized}`);
}

/**
 * Constant-time string comparison (equal-length inputs only — like Node's
 * crypto.timingSafeEqual, a length mismatch returns false immediately rather
 * than padding to compare, since the values compared here are always
 * fixed-format hex/base64 hashes whose length alone carries no secret).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] as number) ^ (bBytes[i] as number);
  }
  return diff === 0;
}
