// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "../types";

/**
 * CSRF defenses for Cookie-authenticated mutating routes (library
 * create/patch/delete now; devices/pairings in a later phase): exact Origin
 * match against WEBAUTHN_ORIGIN, a Sec-Fetch-Site allow-list, and a required
 * JSON Content-Type (plan §5.1). Only call this for state-changing methods
 * (POST/PATCH/PUT/DELETE) — GET routes never need it.
 */

export type CsrfCheckResult = { ok: true } | { ok: false; reason: string };

/** Sec-Fetch-Site values consistent with a same-site fetch/XHR: "same-origin" for a normal browser tab, "none" for a request with no initiating document (e.g. curl, native HTTP clients used by tests/tools). Cross-site values ("cross-site", "same-site") are rejected. */
const ALLOWED_SEC_FETCH_SITES = new Set(["same-origin", "none"]);

/**
 * Pure decision function, given the relevant header values and the
 * configured origin — kept free of any Request-object dependency so it is
 * directly unit-testable (see test/auth-csrf.test.ts).
 */
export function checkCsrf(
  headers: {
    origin: string | null;
    secFetchSite: string | null;
    contentType: string | null;
  },
  expectedOrigin: string,
): CsrfCheckResult {
  if (headers.secFetchSite !== null && !ALLOWED_SEC_FETCH_SITES.has(headers.secFetchSite)) {
    return { ok: false, reason: "unexpected Sec-Fetch-Site" };
  }

  if (headers.origin === null) {
    // Browsers always send Origin on cross-origin-capable mutating requests
    // (POST/PATCH/PUT/DELETE with a body); its absence here is suspicious
    // rather than a normal same-origin omission (that only happens for
    // simple GET navigations, which never reach this check).
    return { ok: false, reason: "missing Origin header" };
  }
  if (headers.origin !== expectedOrigin) {
    return { ok: false, reason: "Origin mismatch" };
  }

  if (!(headers.contentType ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, reason: "Content-Type must be application/json" };
  }

  return { ok: true };
}

/** Runs checkCsrf against a live Request + Env (WEBAUTHN_ORIGIN). Missing config fails closed. */
export function verifyCsrf(
  request: Request,
  env: Pick<Env, "WEBAUTHN_ORIGIN">,
): CsrfCheckResult {
  const expectedOrigin = env.WEBAUTHN_ORIGIN;
  if (expectedOrigin === undefined || expectedOrigin.length === 0) {
    return { ok: false, reason: "WEBAUTHN_ORIGIN is not configured" };
  }
  return checkCsrf(
    {
      origin: request.headers.get("Origin"),
      secFetchSite: request.headers.get("Sec-Fetch-Site"),
      contentType: request.headers.get("Content-Type"),
    },
    expectedOrigin,
  );
}
