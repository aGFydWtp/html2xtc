// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * base64url (RFC 4648 §5, no padding) encode/decode for UTF-8 text. HTTP
 * headers are Latin-1 only, so the PDF upload API (spec §8.1 X-File-Name /
 * X-Pdf-Options, §11.2 X-Pdf-Options / X-Source-Filename) carries arbitrary
 * UTF-8 strings through headers this way.
 */

/** Encodes UTF-8 text as base64url (no padding). */
export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes base64url back to UTF-8 text. Returns null on malformed base64 or
 * invalid UTF-8 instead of throwing, so callers can turn a bad header
 * straight into a 400 without their own try/catch.
 */
export function decodeBase64Url(value: string): string | null {
  // Reject anything outside the base64url alphabet up front — atob() alone
  // would also choke on '+'/'/' (never valid in base64url) and on padding
  // characters mid-string, but a precise allowlist gives a clean null in
  // every malformed case rather than depending on atob()'s exact throw
  // behavior across runtimes.
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    return null;
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null; // invalid UTF-8 byte sequence
  }
}
