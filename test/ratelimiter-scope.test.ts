// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it, vi } from "vitest";

// src/ratelimiter.ts imports DurableObject from "cloudflare:workers" at
// module top level, which only resolves under the real workerd runtime
// (see test/text-preview.test.ts's own doc comment on the same issue,
// and src/ratelimit.ts's doc comment on why the DO class is kept out of
// the plain-vitest-testable helpers). enforcePurposeRateLimit itself is a
// plain function that never touches the DurableObject base class, so a
// minimal stand-in for the import is enough to load the real module (and
// exercise the real branching logic) under plain Node vitest.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { enforcePurposeRateLimit } = await import("../src/ratelimiter");
type Env = import("../src/types").Env;

/**
 * PHASE1_REVIEW.md §Medium: verifies enforcePurposeRateLimit's own
 * account.deletion-facing call path (not just the pure accountRateLimitKey
 * helper in isolation) — with `scope: "account"`, two requests carrying
 * different client IPs must land on the exact same RateLimiter Durable
 * Object instance (same idFromName key) for the same accountId, while the
 * default `scope: "ip"` (every other purpose) keeps giving different IPs
 * their own instance, unchanged.
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
  return new Request("https://example.test/api/me/account", {
    method: "DELETE",
    headers: { "CF-Connecting-IP": ip },
  });
}

describe("enforcePurposeRateLimit — scope: \"account\" (PHASE1_REVIEW.md §Medium)", () => {
  it("uses the same DO key for the same accountId across different client IPs", async () => {
    const namespace = new FakeRateLimiterNamespace();
    const env = { RATE_LIMITER: namespace } as unknown as Env;

    await enforcePurposeRateLimit(requestWithIp("203.0.113.7"), env, {
      purpose: "account.deletion",
      limit: 5,
      failClosed: true,
      extraKey: "acct-1",
      windowMs: 24 * 60 * 60 * 1000,
      scope: "account",
    });
    await enforcePurposeRateLimit(requestWithIp("198.51.100.42"), env, {
      purpose: "account.deletion",
      limit: 5,
      failClosed: true,
      extraKey: "acct-1",
      windowMs: 24 * 60 * 60 * 1000,
      scope: "account",
    });

    expect(namespace.idFromNameCalls).toHaveLength(2);
    // Same account, different IPs -> must resolve to the same DO instance,
    // i.e. the same daily budget, unlike the pre-fix behavior where IP was
    // folded into the key.
    expect(namespace.idFromNameCalls[0]).toBe(namespace.idFromNameCalls[1]);
    expect(namespace.idFromNameCalls[0]).not.toContain("203.0.113.7");
    expect(namespace.idFromNameCalls[0]).not.toContain("198.51.100.42");
  });

  it("still scopes by IP for purposes that don't opt into scope: \"account\" (default unchanged)", async () => {
    const namespace = new FakeRateLimiterNamespace();
    const env = { RATE_LIMITER: namespace } as unknown as Env;

    await enforcePurposeRateLimit(requestWithIp("203.0.113.7"), env, {
      purpose: "auth.login.start",
      limit: 30,
      failClosed: true,
    });
    await enforcePurposeRateLimit(requestWithIp("198.51.100.42"), env, {
      purpose: "auth.login.start",
      limit: 30,
      failClosed: true,
    });

    expect(namespace.idFromNameCalls).toHaveLength(2);
    expect(namespace.idFromNameCalls[0]).not.toBe(namespace.idFromNameCalls[1]);
  });

  it("throws a programmer-error if scope: \"account\" is used without extraKey", async () => {
    const namespace = new FakeRateLimiterNamespace();
    const env = { RATE_LIMITER: namespace } as unknown as Env;

    await expect(
      enforcePurposeRateLimit(requestWithIp("203.0.113.7"), env, {
        purpose: "account.deletion",
        limit: 5,
        failClosed: true,
        scope: "account",
      }),
    ).rejects.toThrow();
  });
});
