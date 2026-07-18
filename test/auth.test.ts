import { describe, expect, it, vi } from "vitest";
import type { AccessJwtVerifier } from "../src/auth";
import { authorize } from "../src/auth";

const TEAM = "https://myteam.cloudflareaccess.com";
const AUD = "aud-tag-0123456789abcdef";

const accessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_POLICY_AUD: AUD };
const bearerEnv = { AUTH_TOKEN: "secret-token" };

const req = (headers: Record<string, string> = {}) =>
  new Request("https://example.com/jobs", { headers });

const allow: AccessJwtVerifier = async () => true;
const deny: AccessJwtVerifier = async () => false;

describe("authorize", () => {
  it("passes everything when no auth mechanism is configured (local dev)", async () => {
    expect(await authorize(req(), {}, deny)).toBeNull();
  });

  describe("Bearer AUTH_TOKEN only", () => {
    it("passes a matching token", async () => {
      expect(
        await authorize(
          req({ Authorization: "Bearer secret-token" }),
          bearerEnv,
          deny,
        ),
      ).toBeNull();
    });

    it("rejects a wrong, malformed, or missing token with 401", async () => {
      const cases: Record<string, string>[] = [
        { Authorization: "Bearer wrong" },
        { Authorization: "secret-token" }, // missing Bearer prefix
        {},
      ];
      for (const headers of cases) {
        const res = await authorize(req(headers), bearerEnv, deny);
        expect(res?.status).toBe(401);
        expect(res?.headers.get("WWW-Authenticate")).toBe("Bearer");
      }
    });
  });

  describe("Access JWT only", () => {
    it("passes when the verifier accepts the header JWT", async () => {
      const verify = vi.fn(allow);
      expect(
        await authorize(
          req({ "Cf-Access-Jwt-Assertion": "jwt-abc" }),
          accessEnv,
          verify,
        ),
      ).toBeNull();
      expect(verify).toHaveBeenCalledWith("jwt-abc", TEAM, AUD);
    });

    it("falls back to the CF_Authorization cookie", async () => {
      const verify = vi.fn(allow);
      expect(
        await authorize(
          req({ Cookie: "foo=bar; CF_Authorization=jwt-cookie" }),
          accessEnv,
          verify,
        ),
      ).toBeNull();
      expect(verify).toHaveBeenCalledWith("jwt-cookie", TEAM, AUD);
    });

    it("returns 401 when the verifier rejects the JWT", async () => {
      const res = await authorize(
        req({ "Cf-Access-Jwt-Assertion": "bad" }),
        accessEnv,
        deny,
      );
      expect(res?.status).toBe(401);
    });

    it("returns 401 without calling the verifier when no JWT is present", async () => {
      const verify = vi.fn(allow);
      const res = await authorize(req(), accessEnv, verify);
      expect(res?.status).toBe(401);
      expect(verify).not.toHaveBeenCalled();
    });

    it("fails closed (401) when only one of the two Access vars is set and no AUTH_TOKEN", async () => {
      // Half-configured Access is a misconfiguration (typo / missing var).
      // It must NOT silently disable auth and let every request through.
      for (const env of [
        { ACCESS_TEAM_DOMAIN: TEAM },
        { ACCESS_POLICY_AUD: AUD },
      ]) {
        const res = await authorize(req(), env, deny);
        expect(res?.status).toBe(401);
      }
    });

    it("does not accept an Access JWT when only one Access var is set", async () => {
      const verify = vi.fn(allow);
      const res = await authorize(
        req({ "Cf-Access-Jwt-Assertion": "jwt-abc" }),
        { ACCESS_TEAM_DOMAIN: TEAM },
        verify,
      );
      expect(res?.status).toBe(401);
      expect(verify).not.toHaveBeenCalled();
    });

    it("accepts a valid Bearer token when Access is half-configured and AUTH_TOKEN is set", async () => {
      const env = { ACCESS_TEAM_DOMAIN: TEAM, ...bearerEnv };
      expect(
        await authorize(req({ Authorization: "Bearer secret-token" }), env, deny),
      ).toBeNull();
    });

    it("rejects a wrong Bearer token (401) when Access is half-configured and AUTH_TOKEN is set", async () => {
      const env = { ACCESS_TEAM_DOMAIN: TEAM, ...bearerEnv };
      const res = await authorize(
        req({ Authorization: "Bearer wrong" }),
        env,
        deny,
      );
      expect(res?.status).toBe(401);
    });

    it("treats empty-string Access vars as unset (local dev pass-through)", async () => {
      // A Wrangler misconfiguration can set vars to "" rather than leaving
      // them undefined; both spellings mean "nothing configured" and stay open.
      expect(
        await authorize(
          req(),
          { ACCESS_TEAM_DOMAIN: "", ACCESS_POLICY_AUD: "" },
          deny,
        ),
      ).toBeNull();
    });
  });

  describe("both mechanisms configured (OR)", () => {
    const env = { ...accessEnv, ...bearerEnv };

    it("passes with a valid Access JWT even without a Bearer token", async () => {
      expect(
        await authorize(req({ "Cf-Access-Jwt-Assertion": "jwt" }), env, allow),
      ).toBeNull();
    });

    it("passes with a valid Bearer token even when the JWT fails", async () => {
      expect(
        await authorize(
          req({
            "Cf-Access-Jwt-Assertion": "bad",
            Authorization: "Bearer secret-token",
          }),
          env,
          deny,
        ),
      ).toBeNull();
    });

    it("returns 401 when both fail", async () => {
      const res = await authorize(
        req({
          "Cf-Access-Jwt-Assertion": "bad",
          Authorization: "Bearer wrong",
        }),
        env,
        deny,
      );
      expect(res?.status).toBe(401);
      expect(await res?.json()).toEqual({ error: "unauthorized" });
    });
  });
});
