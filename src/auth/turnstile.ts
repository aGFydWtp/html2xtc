// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { Errors } from "../security/errors";
import type { Env } from "../types";

/**
 * Cloudflare Turnstile verification for open (invite-less) registration
 * (登録モード仕様 Phase2 §4c). Only ever called from the mode === "open"
 * branch of src/auth/routes.ts's registration/options handler — never on
 * the invite/closed path (Phase2 §6 risk 3).
 *
 * Injectable like src/validate.ts's DnsResolver: production code passes no
 * `verify` argument (defaulting to verifyTurnstileToken, the real
 * siteverify-calling implementation); tests inject a fake TurnstileVerifier
 * directly instead of mocking fetch.
 */
export type TurnstileVerifier = (
  token: string,
  secretKey: string,
  remoteIp: string | null,
) => Promise<boolean>;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 5_000;

/**
 * Real siteverify call — the default TurnstileVerifier. Resolves to
 * whether the token was accepted (the `success` field); throws on any
 * transport/parse failure (non-2xx response, network error, malformed
 * JSON) so the caller (requireTurnstileVerification) can tell "the token
 * was rejected" (400) apart from "verification itself is unavailable"
 * (503, fail-closed).
 */
export async function verifyTurnstileToken(
  token: string,
  secretKey: string,
  remoteIp: string | null,
): Promise<boolean> {
  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp !== null) {
    body.set("remoteip", remoteIp);
  }
  const response = await fetch(SITEVERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`turnstile siteverify returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as { success?: boolean };
  return data.success === true;
}

/**
 * Reads TURNSTILE_SECRET_KEY or throws REGISTRATION_VERIFICATION_UNAVAILABLE
 * (503, fail-closed) — resolved only once the caller has already confirmed
 * mode === "open", so an invite-only deployment that never sets this secret
 * is unaffected (登録モード仕様 Phase2 §6 risk 3).
 */
export function resolveTurnstileSecretKey(env: Pick<Env, "TURNSTILE_SECRET_KEY">): string {
  if (env.TURNSTILE_SECRET_KEY === undefined || env.TURNSTILE_SECRET_KEY.length === 0) {
    throw Errors.serviceUnavailable(
      "REGISTRATION_VERIFICATION_UNAVAILABLE",
      "registration verification is not configured",
    );
  }
  return env.TURNSTILE_SECRET_KEY;
}

/**
 * Verifies a Turnstile token, fail-closed (登録モード仕様 Phase2 §4c): throws
 * REGISTRATION_VERIFICATION_UNAVAILABLE (503) when the secret is
 * unconfigured or the siteverify call/parse itself fails, and
 * INVALID_TURNSTILE_TOKEN (400) when siteverify successfully answered but
 * rejected the token. `verify` defaults to verifyTurnstileToken; tests
 * inject a fake TurnstileVerifier.
 */
export async function requireTurnstileVerification(
  env: Pick<Env, "TURNSTILE_SECRET_KEY">,
  token: string,
  remoteIp: string | null,
  verify: TurnstileVerifier = verifyTurnstileToken,
): Promise<void> {
  const secretKey = resolveTurnstileSecretKey(env);
  let ok: boolean;
  try {
    ok = await verify(token, secretKey, remoteIp);
  } catch (error) {
    console.error("turnstile siteverify request failed", error);
    throw Errors.serviceUnavailable(
      "REGISTRATION_VERIFICATION_UNAVAILABLE",
      "registration verification is unavailable",
    );
  }
  if (!ok) {
    throw Errors.badRequest("INVALID_TURNSTILE_TOKEN", "turnstile verification failed");
  }
}
