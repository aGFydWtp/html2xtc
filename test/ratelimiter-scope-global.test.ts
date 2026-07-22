// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it, vi } from "vitest";

// Same cloudflare:workers stub as test/ratelimiter-scope.test.ts — src/ratelimiter.ts
// imports DurableObject at module top level, which only resolves under the
// real workerd runtime.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { enforcePurposeRateLimit } = await import("../src/ratelimiter");
type Env = import("../src/types").Env;

/**
 * 登録モード仕様 Phase2 §8's `scope: "global"` (the "全体50/日"
 * open-registration-success budget): verifies enforcePurposeRateLimit's own
 * call path, not just globalRateLimitKey in isolation — every request for a
 * given purpose must land on the exact same RateLimiter Durable Object
 * instance regardless of client IP or accountId, while every other scope
 * keeps its own existing behavior unchanged.
 */

class FakeStub {
  calls: Array<{ limit: number; windowMs: number }> = [];
  async takeWithWindow(limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    this.calls.push({ limit, windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

class FakeRateLimiterNamespace {
  idFromNameCalls: string[] = [];
  private readonly stub = new FakeStub();

  idFromName(name: string): string {
    this.idFromNameCalls.push(name);
    return name;
  }

  get(_id: string): FakeStub {
    return this.stub;
  }
}

function requestWithIp(ip: string): Request {
  return new Request("https://example.test/api/auth/registration/verify", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('enforcePurposeRateLimit — scope: "global" (登録モード仕様 Phase2 §8)', () => {
  it("uses the same DO key for the same purpose across different client IPs", async () => {
    const namespace = new FakeRateLimiterNamespace();
    const env = { RATE_LIMITER: namespace } as unknown as Env;

    await enforcePurposeRateLimit(requestWithIp("203.0.113.7"), env, {
      purpose: "auth.registration.open.succeeded",
      limit: 50,
      windowMs: DAY_MS,
      failClosed: true,
      scope: "global",
    });
    await enforcePurposeRateLimit(requestWithIp("198.51.100.42"), env, {
      purpose: "auth.registration.open.succeeded",
      limit: 50,
      windowMs: DAY_MS,
      failClosed: true,
      scope: "global",
    });

    expect(namespace.idFromNameCalls).toHaveLength(2);
    expect(namespace.idFromNameCalls[0]).toBe(namespace.idFromNameCalls[1]);
    expect(namespace.idFromNameCalls[0]).not.toContain("203.0.113.7");
    expect(namespace.idFromNameCalls[0]).not.toContain("198.51.100.42");
  });

  it("gives different purposes different DO keys even though both are scope: \"global\"", async () => {
    const namespace = new FakeRateLimiterNamespace();
    const env = { RATE_LIMITER: namespace } as unknown as Env;

    await enforcePurposeRateLimit(requestWithIp("203.0.113.7"), env, {
      purpose: "auth.registration.open.succeeded",
      limit: 50,
      windowMs: DAY_MS,
      failClosed: true,
      scope: "global",
    });
    await enforcePurposeRateLimit(requestWithIp("203.0.113.7"), env, {
      purpose: "auth.registration.open.succeeded_per_ip",
      limit: 3,
      windowMs: DAY_MS,
      failClosed: true,
      scope: "global",
    });

    expect(namespace.idFromNameCalls[0]).not.toBe(namespace.idFromNameCalls[1]);
  });

  it("still scopes by IP for purposes that don't opt into scope: \"global\" (default unchanged)", async () => {
    const namespace = new FakeRateLimiterNamespace();
    const env = { RATE_LIMITER: namespace } as unknown as Env;

    await enforcePurposeRateLimit(requestWithIp("203.0.113.7"), env, {
      purpose: "auth.registration.open.succeeded_per_ip",
      limit: 3,
      windowMs: DAY_MS,
      failClosed: true,
    });
    await enforcePurposeRateLimit(requestWithIp("198.51.100.42"), env, {
      purpose: "auth.registration.open.succeeded_per_ip",
      limit: 3,
      windowMs: DAY_MS,
      failClosed: true,
    });

    expect(namespace.idFromNameCalls[0]).not.toBe(namespace.idFromNameCalls[1]);
  });
});
