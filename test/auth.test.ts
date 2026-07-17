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

    it("stays inactive when only one of the two Access vars is set", async () => {
      // Half-configured Access must not lock out local dev (no AUTH_TOKEN).
      expect(
        await authorize(req(), { ACCESS_TEAM_DOMAIN: TEAM }, deny),
      ).toBeNull();
      expect(
        await authorize(req(), { ACCESS_POLICY_AUD: AUD }, deny),
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
