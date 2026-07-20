import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  buildExpiredSessionCookie,
  buildSessionCookie,
  generateSessionToken,
  hashSessionToken,
  isSessionValid,
  parseCookieHeader,
  parseSessionCookie,
  resolveSessionTtlDays,
} from "../src/auth/sessions";
import type { SessionRecord } from "../src/auth/sessions";

describe("generateSessionToken", () => {
  it("produces a high-entropy, unique-looking token", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("hashSessionToken", () => {
  it("is deterministic for the same token and pepper", async () => {
    expect(await hashSessionToken("token", "pepper")).toBe(
      await hashSessionToken("token", "pepper"),
    );
  });

  it("changes when the pepper changes (so a leaked hash alone isn't replayable across peppers)", async () => {
    expect(await hashSessionToken("token", "pepper-a")).not.toBe(
      await hashSessionToken("token", "pepper-b"),
    );
  });

  it("changes when the token changes", async () => {
    expect(await hashSessionToken("token-a", "pepper")).not.toBe(
      await hashSessionToken("token-b", "pepper"),
    );
  });
});

describe("buildSessionCookie / buildExpiredSessionCookie", () => {
  it("sets the __Host- cookie with Secure, HttpOnly, SameSite=Lax, Path=/", () => {
    const cookie = buildSessionCookie("tok123", 3600);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=tok123`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("expires the cookie immediately for logout", () => {
    const cookie = buildExpiredSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("parseCookieHeader / parseSessionCookie", () => {
  it("extracts the named cookie among several", () => {
    expect(
      parseCookieHeader(`foo=bar; ${SESSION_COOKIE_NAME}=abc123; baz=qux`, SESSION_COOKIE_NAME),
    ).toBe("abc123");
  });

  it("returns null when the header is missing", () => {
    expect(parseCookieHeader(null, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("returns null when the named cookie isn't present", () => {
    expect(parseCookieHeader("foo=bar", SESSION_COOKIE_NAME)).toBeNull();
  });

  it("parseSessionCookie reads the session cookie off a real Request", () => {
    const request = new Request("https://example.com/", {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=my-token` },
    });
    expect(parseSessionCookie(request)).toBe("my-token");
  });

  it("parseSessionCookie returns null with no Cookie header", () => {
    const request = new Request("https://example.com/");
    expect(parseSessionCookie(request)).toBeNull();
  });
});

describe("resolveSessionTtlDays", () => {
  it("defaults to 30 days", () => {
    expect(resolveSessionTtlDays({})).toBe(30);
  });

  it("honors a positive override", () => {
    expect(resolveSessionTtlDays({ SESSION_TTL_DAYS: "7" })).toBe(7);
  });

  it("falls back to the default on garbage or non-positive values", () => {
    expect(resolveSessionTtlDays({ SESSION_TTL_DAYS: "banana" })).toBe(30);
    expect(resolveSessionTtlDays({ SESSION_TTL_DAYS: "0" })).toBe(30);
    expect(resolveSessionTtlDays({ SESSION_TTL_DAYS: "-3" })).toBe(30);
  });
});

describe("isSessionValid", () => {
  const T0 = 1_700_000_000_000;
  const base: SessionRecord = {
    accountId: "acct-1",
    displayName: "Haruki",
    expiresAt: new Date(T0 + 1000).toISOString(),
    revokedAt: null,
  };

  it("is valid before expiry and not revoked", () => {
    expect(isSessionValid(base, T0)).toBe(true);
  });

  it("rejects an expired session", () => {
    expect(isSessionValid(base, T0 + 2000)).toBe(false);
  });

  it("rejects a revoked session even if not yet expired", () => {
    expect(isSessionValid({ ...base, revokedAt: new Date(T0).toISOString() }, T0)).toBe(false);
  });

  it("treats the expiry instant itself as expired (strict greater-than)", () => {
    expect(isSessionValid(base, T0 + 1000)).toBe(false);
  });
});
