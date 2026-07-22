// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import type { TurnstileVerifier } from "../src/auth/turnstile";
import { requireTurnstileVerification, resolveTurnstileSecretKey } from "../src/auth/turnstile";
import { ApiError } from "../src/security/errors";

/**
 * 登録モード仕様 Phase2 §4c: fail-closed Turnstile verification. Mirrors
 * src/validate.ts's DnsResolver injection test pattern (test/validate.test.ts)
 * — a fake TurnstileVerifier is injected directly, no real fetch involved.
 */

describe("resolveTurnstileSecretKey", () => {
  it("returns the configured secret", () => {
    expect(resolveTurnstileSecretKey({ TURNSTILE_SECRET_KEY: "s3cr3t" })).toBe("s3cr3t");
  });

  it("throws a 503 ApiError when unset", () => {
    expect(() => resolveTurnstileSecretKey({})).toThrow(ApiError);
    try {
      resolveTurnstileSecretKey({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(503);
      expect((error as ApiError).code).toBe("REGISTRATION_VERIFICATION_UNAVAILABLE");
    }
  });

  it("throws a 503 ApiError when set to an empty string", () => {
    expect(() => resolveTurnstileSecretKey({ TURNSTILE_SECRET_KEY: "" })).toThrow(ApiError);
  });
});

describe("requireTurnstileVerification", () => {
  const env = { TURNSTILE_SECRET_KEY: "s3cr3t" };

  it("resolves without throwing when the verifier reports success", async () => {
    const verify: TurnstileVerifier = async () => true;
    await expect(requireTurnstileVerification(env, "token-ok", "203.0.113.7", verify)).resolves.toBeUndefined();
  });

  it("passes the secret key and remoteIp through to the verifier", async () => {
    let seen: [string, string, string | null] | null = null;
    const verify: TurnstileVerifier = async (token, secretKey, remoteIp) => {
      seen = [token, secretKey, remoteIp];
      return true;
    };
    await requireTurnstileVerification(env, "token-abc", "203.0.113.7", verify);
    expect(seen).toEqual(["token-abc", "s3cr3t", "203.0.113.7"]);
  });

  it("throws 400 INVALID_TURNSTILE_TOKEN when the verifier reports failure (not 503 — the token was actually checked)", async () => {
    const verify: TurnstileVerifier = async () => false;
    try {
      await requireTurnstileVerification(env, "token-bad", null, verify);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).code).toBe("INVALID_TURNSTILE_TOKEN");
    }
  });

  it("throws 503 REGISTRATION_VERIFICATION_UNAVAILABLE (fail-closed) when the verifier itself throws (transport/parse failure)", async () => {
    const verify: TurnstileVerifier = async () => {
      throw new Error("network error");
    };
    try {
      await requireTurnstileVerification(env, "token-x", null, verify);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(503);
      expect((error as ApiError).code).toBe("REGISTRATION_VERIFICATION_UNAVAILABLE");
    }
  });

  it("throws 503 fail-closed, never calling the verifier, when TURNSTILE_SECRET_KEY is unset", async () => {
    let called = false;
    const verify: TurnstileVerifier = async () => {
      called = true;
      return true;
    };
    await expect(requireTurnstileVerification({}, "token-x", null, verify)).rejects.toMatchObject({
      status: 503,
      code: "REGISTRATION_VERIFICATION_UNAVAILABLE",
    });
    expect(called).toBe(false);
  });
});
