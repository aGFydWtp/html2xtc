// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Security headers + a per-request correlation ID applied to every response
 * produced by the new Router-handled routes (src/router.ts). The legacy
 * route() responses in src/index.ts are left untouched by this module —
 * only what passes through Router.handle() is wrapped.
 */

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Frame-Options", "DENY"],
];

/** Generates a per-request correlation ID for logs and the X-Request-Id header. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Returns a new Response with the security headers + X-Request-Id merged
 * in (without overriding a header the handler already set), preserving the
 * original status and body.
 */
export function withSecurityHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of SECURITY_HEADERS) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
