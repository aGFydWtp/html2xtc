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
 * the limit within RATE_LIMIT_WINDOW_MS of the window start are denied, and
 * the first request after that span opens a fresh window.
 */
export function decideFixedWindow(
  prev: RateLimitWindow | undefined,
  nowMs: number,
  limit: number,
): RateLimitDecision {
  const window =
    prev !== undefined && nowMs - prev.windowStartMs < RATE_LIMIT_WINDOW_MS
      ? prev
      : { windowStartMs: nowMs, count: 0 };

  if (window.count >= limit) {
    return {
      allowed: false,
      next: window,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((window.windowStartMs + RATE_LIMIT_WINDOW_MS - nowMs) / 1000),
      ),
    };
  }
  return {
    allowed: true,
    next: { windowStartMs: window.windowStartMs, count: window.count + 1 },
    retryAfterSeconds: 0,
  };
}
