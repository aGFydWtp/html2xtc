// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "./types";
import { parseIpv6 } from "./validate";

/**
 * Pure helpers for the per-IP rate limit on the conversion-starting
 * endpoints (POST /convert, POST /jobs): key normalization, the fixed-window
 * decision, and the limit's env-var resolution.
 *
 * Kept free of cloudflare:* runtime imports so the logic stays unit-testable
 * under plain vitest (see test/ratelimit.test.ts); the Durable Object that
 * holds the window state lives in src/ratelimiter.ts.
 */

/** Fixed window length: requests are counted per clock-hour-sized window. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const DEFAULT_RATE_LIMIT_PER_HOUR = 50;

/**
 * Requests allowed per IP key per window; the RATE_LIMIT_PER_HOUR var
 * overrides the default of 50. Same fallback shape as resolveMaxPdfBytes
 * (src/jobs.ts): zero, negative, and non-numeric values mean "use the
 * default", they never disable the limit.
 */
export function resolveRateLimitPerHour(
  env: Pick<Env, "RATE_LIMIT_PER_HOUR">,
): number {
  const configured = Number(env.RATE_LIMIT_PER_HOUR);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_RATE_LIMIT_PER_HOUR;
}

const DEFAULT_TEXT_PREVIEW_RATE_LIMIT_PER_HOUR = 20;

/**
 * Requests allowed per IP key per window for POST /preview/text (preview
 * spec §8), namespaced away from the /convert+/jobs limit via
 * purposeRateLimitKey/enforcePurposeRateLimit (src/ratelimiter.ts). Same
 * fallback shape as resolveRateLimitPerHour above.
 */
export function resolveTextPreviewRateLimitPerHour(
  env: Pick<Env, "TEXT_PREVIEW_RATE_LIMIT_PER_HOUR">,
): number {
  const configured = Number(env.TEXT_PREVIEW_RATE_LIMIT_PER_HOUR);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_TEXT_PREVIEW_RATE_LIMIT_PER_HOUR;
}

/**
 * Normalizes a client IP (the CF-Connecting-IP header value) into the name
 * of the Durable Object that counts its requests.
 *
 * - IPv4: the full address is the key.
 * - IPv6: rounded down to the /64 prefix. Providers hand out at least a /64
 *   per subscriber, so counting individual addresses would let an attacker
 *   rotate through 2^64 of them; the prefix is the accountable unit.
 * - null/empty/unparseable: returns null, meaning "skip rate limiting".
 *   The header is absent in local `wrangler dev` (no Cloudflare edge in
 *   front), and an unparseable value cannot occur from the real edge, so
 *   skipping keeps dev friction-free without opening a production bypass.
 */
export function rateLimitKey(clientIp: string | null): string | null {
  const ip = clientIp?.trim() ?? "";
  if (ip.length === 0) {
    return null;
  }
  if (ip.includes(":")) {
    const words = parseIpv6(ip);
    if (words === null) {
      return null;
    }
    return `v6:${words
      .slice(0, 4)
      .map((word) => word.toString(16))
      .join(":")}`;
  }
  return `v4:${ip}`;
}

/**
 * Builds a compound rate-limit key for a specific purpose (plan §13):
 * prefixing the purpose name onto the plain IP key gives every purpose its
 * own counter namespace (a separate RateLimiter Durable Object instance,
 * since idFromName hashes the whole string) so purposes never share a
 * window with each other, or with the existing /convert + /jobs limiter
 * (which still calls idFromName on the bare rateLimitKey() output with no
 * prefix — see enforceRateLimit, src/ratelimiter.ts — and is deliberately
 * left untouched by this addition). `extra` adds a further scoping
 * dimension, e.g. deviceId for the "端末認証失敗 IP＋deviceId" limit (plan
 * §13's table). Returns null when ipKey is null (see rateLimitKey's own
 * doc for when that happens) so the caller can uniformly skip.
 */
export function purposeRateLimitKey(purpose: string, ipKey: string | null, extra?: string): string | null {
  if (ipKey === null) {
    return null;
  }
  return extra !== undefined ? `${purpose}:${ipKey}:${extra}` : `${purpose}:${ipKey}`;
}

/**
 * IP-independent counterpart to purposeRateLimitKey, for purposes that must
 * stay scoped to a stable identifier (an accountId) rather than the
 * client's IP (PHASE1_REVIEW.md §Medium: account.deletion's "5/日/account"
 * limit, 登録モード仕様 Phase1 §5.7/§8d, was accidentally also scoped by IP
 * because every existing purpose goes through purposeRateLimitKey, so
 * switching IPs reset the budget). Every purpose but account.deletion keeps
 * calling purposeRateLimitKey above unchanged — this is opted into per call
 * site via enforcePurposeRateLimit's `scope: "account"` option
 * (src/ratelimiter.ts), not a default.
 */
export function accountRateLimitKey(purpose: string, accountId: string): string {
  return `${purpose}:account:${accountId}`;
}

/** Window state as persisted in the Durable Object's storage. */
export interface RateLimitWindow {
  windowStartMs: number;
  count: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /**
   * State to persist. On a denied request within a live window this is the
   * `prev` object itself (unchanged), so the caller can skip the write.
   */
  next: RateLimitWindow;
  /** Seconds until the window resets; the Retry-After value when denied. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window decision: the first request opens a window, requests beyond
 * the limit within `windowMs` of the window start are denied, and the first
 * request after that span opens a fresh window. `windowMs` defaults to
 * RATE_LIMIT_WINDOW_MS (1 hour) — every existing call site keeps its
 * original 3-arg call and behavior unchanged; a 4th arg lets a purpose opt
 * into a different window (e.g. the account-deletion "5/日" limit, 登録モード
 * 仕様 Phase1 §5.7/§8d).
 */
export function decideFixedWindow(
  prev: RateLimitWindow | undefined,
  nowMs: number,
  limit: number,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): RateLimitDecision {
  const window =
    prev !== undefined && nowMs - prev.windowStartMs < windowMs
      ? prev
      : { windowStartMs: nowMs, count: 0 };

  if (window.count >= limit) {
    return {
      allowed: false,
      next: window,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((window.windowStartMs + windowMs - nowMs) / 1000),
      ),
    };
  }
  return {
    allowed: true,
    next: { windowStartMs: window.windowStartMs, count: window.count + 1 },
    retryAfterSeconds: 0,
  };
}
