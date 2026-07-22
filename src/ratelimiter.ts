// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { DurableObject } from "cloudflare:workers";
import {
  RATE_LIMIT_WINDOW_MS,
  accountRateLimitKey,
  decideFixedWindow,
  purposeRateLimitKey,
  rateLimitKey,
  resolveRateLimitPerHour,
} from "./ratelimit";
import type { RateLimitWindow } from "./ratelimit";
import type { Env } from "./types";

/** Storage key for the single window record each RateLimiter instance holds. */
const WINDOW_KEY = "window";

/**
 * Per-IP fixed-window counter. idFromName over the normalized IP key (see
 * rateLimitKey) funnels all requests from one IP (or IPv6 /64) into one
 * instance, whose single-threaded execution makes the read-decide-write
 * below race-free. State is one tiny record in the built-in SQLite-backed
 * key-value storage.
 */
export class RateLimiter extends DurableObject<Env> {
  /**
   * Counts one request against the caller's window and reports whether it is
   * allowed. The limit is resolved by the Worker (one place, next to the
   * check) and passed in, mirroring how resolveMaxPdfBytes is used.
   */
  async take(
    limit: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    return this.takeWithWindow(limit, RATE_LIMIT_WINDOW_MS);
  }

  /**
   * Same as take(), but with a caller-chosen window length instead of the
   * fixed 1-hour window — added for the account-deletion "5/日" limit (登録
   * モード仕様 Phase1 §5.7/§8d) without changing take()'s signature or
   * behavior for its many existing 1-hour callers (plan gap analysis §6:
   * "既存の1時間窓呼び出し元には影響を出さない"). Each purpose+key already
   * gets its own RateLimiter DO instance (idFromName on the purpose-prefixed
   * key), so reusing the same WINDOW_KEY storage slot here is safe — a given
   * instance only ever serves one purpose, hence one window length.
   */
  async takeWithWindow(
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const prev = await this.ctx.storage.get<RateLimitWindow>(WINDOW_KEY);
    const decision = decideFixedWindow(prev, Date.now(), limit, windowMs);
    // decideFixedWindow returns `prev` itself for a denied request within a
    // live window; skipping the write keeps a flood of denied requests from
    // hammering storage.
    if (decision.next !== prev) {
      await this.ctx.storage.put(WINDOW_KEY, decision.next);
    }
    return {
      allowed: decision.allowed,
      retryAfterSeconds: decision.retryAfterSeconds,
    };
  }
}

/**
 * Rate-limit gate for the conversion-starting endpoints. Returns the 429
 * Response to send as-is, or null to let the request through.
 *
 * The client IP comes from CF-Connecting-IP, which the Cloudflare edge sets
 * from the connection itself — unlike X-Forwarded-For it cannot be spoofed
 * by the client. The header is absent only in local `wrangler dev`, where
 * rateLimitKey returns null and the limit is skipped.
 */
export async function enforceRateLimit(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const key = rateLimitKey(request.headers.get("CF-Connecting-IP"));
  if (key === null) {
    return null;
  }

  let result: { allowed: boolean; retryAfterSeconds: number };
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
    result = await stub.take(resolveRateLimitPerHour(env));
  } catch (error) {
    // Fail open: a Durable Object hiccup must not take the whole API down
    // (same availability-over-strictness stance as the DoH outage path in
    // validate.ts). Trade-off: during such an outage the limit is not
    // enforced — acceptable, since the limiter protects capacity rather
    // than confidentiality.
    console.error("rate limiter unavailable", error);
    return null;
  }

  if (result.allowed) {
    return null;
  }
  return Response.json(
    { error: "rate limit exceeded; try again later" },
    {
      status: 429,
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    },
  );
}

/** Options for enforcePurposeRateLimit (plan §13's per-purpose table). */
export interface PurposeRateLimitOptions {
  /** Namespaces this purpose's counter away from every other purpose and from the plain /convert+/jobs limiter (see purposeRateLimitKey). */
  purpose: string;
  /** Requests allowed per hour for this purpose+key. */
  limit: number;
  /** Extra key dimension, e.g. a deviceId, for limits scoped tighter than "per IP" alone. */
  extraKey?: string;
  /**
   * Window length in ms; defaults to RATE_LIMIT_WINDOW_MS (1 hour) when
   * omitted, matching every existing purpose's behavior unchanged. Set this
   * for a purpose that needs a different window, e.g. the account-deletion
   * "5/日" limit (24h).
   */
  windowMs?: number;
  /**
   * Whether a RateLimiter DO outage should block the request (auth,
   * pairing, device-auth-failure — plan §13 "原則fail-closed") or let it
   * through unlimited (matching enforceRateLimit's existing fail-open
   * stance for the public conversion API).
   */
  failClosed: boolean;
  /**
   * Key scope (PHASE1_REVIEW.md §Medium):
   * - "ip" (default): every purpose so far — the counter is per (purpose,
   *   client IP[, extraKey]), via purposeRateLimitKey. Omitting this field
   *   keeps existing call sites byte-for-byte unchanged.
   * - "account": the counter is per (purpose, extraKey) only, via
   *   accountRateLimitKey — the client's IP plays no part, so switching IPs
   *   cannot reset the budget. Requires `extraKey` (treated as the
   *   accountId). Only account.deletion (src/auth/routes.ts) uses this.
   */
  scope?: "ip" | "account";
}

/**
 * Per-purpose rate-limit gate (plan §13): unlike enforceRateLimit (one
 * shared counter for /convert + /jobs), each call site here gets its own
 * counter namespace and its own limit/fail-open-vs-closed policy, chosen at
 * the call site via `purpose`/`limit`/`failClosed`. The same RateLimiter DO
 * class and decideFixedWindow logic is reused — only the key and the
 * outage behavior differ.
 *
 * Returns the 429 (or, on a fail-closed outage, 503) Response to send
 * as-is, or null to let the request through.
 */
export async function enforcePurposeRateLimit(
  request: Request,
  env: Env,
  options: PurposeRateLimitOptions,
): Promise<Response | null> {
  let key: string | null;
  if (options.scope === "account") {
    if (options.extraKey === undefined) {
      // Programmer error, not a runtime/user condition: every scope:
      // "account" call site must supply the accountId as extraKey.
      throw new Error(
        `enforcePurposeRateLimit: scope "account" requires extraKey (accountId) for purpose "${options.purpose}"`,
      );
    }
    key = accountRateLimitKey(options.purpose, options.extraKey);
  } else {
    const ipKey = rateLimitKey(request.headers.get("CF-Connecting-IP"));
    key = purposeRateLimitKey(options.purpose, ipKey, options.extraKey);
  }
  if (key === null) {
    // No client IP to scope by (local dev, or an edge that stripped the
    // header) — see rateLimitKey's own doc; this cannot happen from the
    // real Cloudflare edge in production. Only reachable for scope: "ip"
    // (the default) — scope: "account" always produces a key.
    return null;
  }

  let result: { allowed: boolean; retryAfterSeconds: number };
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
    result = await stub.takeWithWindow(options.limit, options.windowMs ?? RATE_LIMIT_WINDOW_MS);
  } catch (error) {
    console.error(`rate limiter unavailable (${options.purpose})`, error);
    if (options.failClosed) {
      return Response.json(
        { error: { code: "RATE_LIMITER_UNAVAILABLE", message: "try again later" } },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    return null;
  }

  if (result.allowed) {
    return null;
  }
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "rate limit exceeded; try again later" } },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
  );
}
