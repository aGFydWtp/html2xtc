// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 haruki

import { DurableObject } from "cloudflare:workers";
import {
  decideFixedWindow,
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
    const prev = await this.ctx.storage.get<RateLimitWindow>(WINDOW_KEY);
    const decision = decideFixedWindow(prev, Date.now(), limit);
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
    // than confidentiality, and authorize() has already run.
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
