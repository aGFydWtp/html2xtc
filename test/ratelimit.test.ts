import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_WINDOW_MS,
  decideFixedWindow,
  purposeRateLimitKey,
  rateLimitKey,
  resolveRateLimitPerHour,
} from "../src/ratelimit";
import type { RateLimitWindow } from "../src/ratelimit";

describe("rateLimitKey", () => {
  it("keys IPv4 addresses on the full address", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("v4:203.0.113.7");
    expect(rateLimitKey("203.0.113.8")).not.toBe(rateLimitKey("203.0.113.7"));
  });

  it("rounds IPv6 addresses down to their /64 prefix", () => {
    // Same /64: rotating the interface identifier must not change the key.
    expect(rateLimitKey("2001:db8:12:34::1")).toBe(
      rateLimitKey("2001:db8:12:34:ffff:ffff:ffff:ffff"),
    );
    expect(rateLimitKey("2001:db8:12:34::1")).toBe("v6:2001:db8:12:34");
    // Different /64: separate keys.
    expect(rateLimitKey("2001:db8:12:35::1")).not.toBe(
      rateLimitKey("2001:db8:12:34::1"),
    );
  });

  it("returns null (skip) for a missing or empty header value", () => {
    expect(rateLimitKey(null)).toBeNull();
    expect(rateLimitKey("")).toBeNull();
    expect(rateLimitKey("   ")).toBeNull();
  });

  it("returns null for an unparseable IPv6 literal", () => {
    expect(rateLimitKey("2001:db8::1::2")).toBeNull();
    expect(rateLimitKey(":::")).toBeNull();
  });
});

describe("purposeRateLimitKey", () => {
  it("prefixes the purpose onto the IP key", () => {
    expect(purposeRateLimitKey("auth.login.start", "v4:203.0.113.7")).toBe(
      "auth.login.start:v4:203.0.113.7",
    );
  });

  it("appends the extra key dimension when given (e.g. deviceId)", () => {
    expect(purposeRateLimitKey("device.auth.failed", "v4:203.0.113.7", "device-1")).toBe(
      "device.auth.failed:v4:203.0.113.7:device-1",
    );
  });

  it("returns null when ipKey is null, regardless of extra", () => {
    expect(purposeRateLimitKey("auth.login.start", null)).toBeNull();
    expect(purposeRateLimitKey("device.auth.failed", null, "device-1")).toBeNull();
  });

  it("gives different purposes distinct keys for the same IP", () => {
    const a = purposeRateLimitKey("auth.login.start", "v4:203.0.113.7");
    const b = purposeRateLimitKey("auth.registration.start", "v4:203.0.113.7");
    expect(a).not.toBe(b);
  });

  it("never collides with the un-prefixed key the existing /convert+/jobs limiter uses", () => {
    // The legacy limiter calls idFromName(rateLimitKey(ip)) directly, with
    // no purpose prefix at all — as long as no real purpose string is empty,
    // "<purpose>:v4:1.2.3.4" can never equal the bare "v4:1.2.3.4".
    const bare = rateLimitKey("203.0.113.7")!;
    const namespaced = purposeRateLimitKey("auth.login.start", bare);
    expect(namespaced).not.toBe(bare);
  });
});

describe("decideFixedWindow", () => {
  const T0 = 1_700_000_000_000;

  /** Runs `n` sequential requests from t=T0 and returns the final decision. */
  const run = (n: number, limit: number) => {
    let state: RateLimitWindow | undefined;
    let decision = decideFixedWindow(state, T0, limit);
    for (let i = 1; i < n; i++) {
      state = decision.next;
      decision = decideFixedWindow(state, T0 + i, limit);
    }
    return decision;
  };

  it("allows requests up to the limit", () => {
    expect(run(50, 50).allowed).toBe(true);
    expect(run(50, 50).next.count).toBe(50);
  });

  it("denies the request beyond the limit", () => {
    expect(run(51, 50).allowed).toBe(false);
  });

  it("reports the seconds until the window resets as Retry-After", () => {
    const full = run(50, 50).next;
    // 10 minutes into the window: 50 minutes (3000s) remain.
    const denied = decideFixedWindow(full, T0 + 10 * 60 * 1000, 50);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(50 * 60);
  });

  it("never reports a Retry-After below 1 second", () => {
    const full = run(50, 50).next;
    const denied = decideFixedWindow(full, T0 + RATE_LIMIT_WINDOW_MS - 1, 50);
    expect(denied.retryAfterSeconds).toBe(1);
  });

  it("returns the previous state unchanged when denying (no storage write)", () => {
    const full = run(50, 50).next;
    const denied = decideFixedWindow(full, T0 + 1000, 50);
    expect(denied.next).toBe(full);
  });

  it("opens a fresh window once the hour has passed", () => {
    const full = run(50, 50).next;
    const later = decideFixedWindow(full, T0 + RATE_LIMIT_WINDOW_MS, 50);
    expect(later.allowed).toBe(true);
    expect(later.next).toEqual({
      windowStartMs: T0 + RATE_LIMIT_WINDOW_MS,
      count: 1,
    });
  });
});

describe("resolveRateLimitPerHour", () => {
  it("defaults to 50 when the var is unset", () => {
    expect(resolveRateLimitPerHour({})).toBe(50);
  });

  it("falls back to the default for non-numeric, zero, negative, and non-integer values", () => {
    for (const value of ["abc", "0", "-5", "3.5", ""]) {
      expect(resolveRateLimitPerHour({ RATE_LIMIT_PER_HOUR: value })).toBe(50);
    }
  });

  it("adopts a configured positive integer", () => {
    expect(resolveRateLimitPerHour({ RATE_LIMIT_PER_HOUR: "100" })).toBe(100);
  });
});
