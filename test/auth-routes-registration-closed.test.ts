// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it, vi } from "vitest";
import { Router } from "../src/router";
import { ApiError } from "../src/security/errors";
import type { Env } from "../src/types";

// src/auth/routes.ts pulls in src/ratelimiter.ts, which imports
// DurableObject from cloudflare:workers at module top level — that only
// resolves under the real workerd runtime. Same stub as
// test/ratelimiter-scope-global.test.ts.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

/**
 * 登録モード仕様 Phase3 §5.3: POST /api/auth/registration/verify が
 * finishRegistration からの REGISTRATION_CLOSED を受け取ったとき、
 *   - 403 REGISTRATION_CLOSED をそのままクライアントへ返す
 *   - auth.registration.verify_failed (10/h/IP, fail-closed) のレート制限
 *     バジェットを消費しない（RATE_LIMITER に一切触れない）
 * ことを、実際の router 経由（registerAuthRoutes）で確認する。
 * finishRegistration はモジュールごとモックし、webauthn.ts 内部の
 * challenge/D1 まわりは一切扱わない（それは
 * test/auth-webauthn-registration-closed.test.ts の担当）。
 */
vi.mock("../src/auth/webauthn", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/webauthn")>("../src/auth/webauthn");
  return {
    ...actual,
    finishRegistration: vi.fn(async () => {
      throw new ApiError(403, "REGISTRATION_CLOSED", "new account registration is closed");
    }),
  };
});

const { registerAuthRoutes } = await import("../src/auth/routes");

class ExplodingRateLimiterNamespace {
  idFromName(): never {
    throw new Error("RATE_LIMITER must not be touched for a REGISTRATION_CLOSED rejection");
  }
  get(): never {
    throw new Error("RATE_LIMITER must not be touched for a REGISTRATION_CLOSED rejection");
  }
}

function buildEnv(): Env {
  return {
    WEBAUTHN_ORIGIN: "https://xtc.hr20k.com",
    WEBAUTHN_RP_ID: "xtc.hr20k.com",
    RATE_LIMITER: new ExplodingRateLimiterNamespace(),
  } as unknown as Env;
}

describe("POST /api/auth/registration/verify — REGISTRATION_CLOSED from finishRegistration", () => {
  it("returns 403 REGISTRATION_CLOSED and never touches the verify_failed rate limiter", async () => {
    const router = new Router();
    registerAuthRoutes(router);
    const env = buildEnv();

    const response = await router.handle(
      new Request("https://example.com/api/auth/registration/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "none",
          Origin: "https://xtc.hr20k.com",
        },
        body: JSON.stringify({ response: { id: "cred-abc" } }),
      }),
      env,
    );

    expect(response).not.toBeNull();
    expect((response as Response).status).toBe(403);
    const body = (await (response as Response).json()) as { error: { code: string } };
    expect(body.error.code).toBe("REGISTRATION_CLOSED");
    // No throw from ExplodingRateLimiterNamespace means RATE_LIMITER was
    // never touched — the assertion above already proves the request
    // completed without hitting it.
  });
});
