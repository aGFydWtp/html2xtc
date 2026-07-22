// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { registerPublicConfigRoute } from "../src/public-config";
import { Router } from "../src/router";
import type { Env } from "../src/types";

/**
 * 登録モード仕様 Phase2 §5: GET /api/public/config. Covers the two
 * properties the Phase2 review (PHASE2_REVIEW.md Medium #1) flagged as
 * untested directly:
 *   - no information leak (secrets, raw accountCount, internal R2 usage,
 *     raw admin storage-percent thresholds never appear in the response)
 *   - registrationAvailable's composite judgement (mode !== "closed" AND
 *     under the total-account cap AND under the storage stop threshold)
 *
 * Narrow FakeD1 scoped to exactly the two queries isRegistrationAvailable
 * issues (COUNT(*) FROM accounts, SUM(size_bytes) FROM library_items) —
 * same narrow-fake convention as test/db-cleanup.test.ts and
 * test/auth-webauthn-open-registration.test.ts (no existing test in this
 * repo drives a real D1 instance).
 */
class FakeD1 {
  constructor(
    readonly accountCount: number,
    readonly libraryBytes: number,
  ) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(): FakeStatement {
    return this;
  }

  async first<T>(): Promise<T> {
    if (this.sql.includes("FROM accounts")) {
      return { count: this.db.accountCount } as unknown as T;
    }
    if (this.sql.includes("FROM library_items")) {
      return { total: this.db.libraryBytes } as unknown as T;
    }
    throw new Error(`FakeD1: unexpected SQL: ${this.sql}`);
  }
}

function buildEnv(overrides: Partial<Env> & { accountCount?: number; libraryBytes?: number } = {}): Env {
  const { accountCount = 0, libraryBytes = 0, ...envOverrides } = overrides;
  const db = new FakeD1(accountCount, libraryBytes);
  return {
    APP_DB: db,
    ...envOverrides,
  } as unknown as Env;
}

async function callPublicConfig(env: Env): Promise<Response> {
  const router = new Router();
  registerPublicConfigRoute(router);
  const response = await router.handle(new Request("https://example.com/api/public/config"), env);
  expect(response).not.toBeNull();
  return response as Response;
}

const SECRET_LEAK_KEYS = [
  "TURNSTILE_SECRET_KEY",
  "REGISTRATION_IP_PEPPER",
  "INTERNAL_STATUS_SECRET",
  "SESSION_PEPPER",
  "secret",
  "accountCount",
  "libraryBytes",
];

describe("GET /api/public/config", () => {
  it("returns the expected shape for mode=invite", async () => {
    const env = buildEnv({ REGISTRATION_MODE: "invite", TERMS_VERSION: "2026-01-01", TURNSTILE_SITE_KEY: "site-key-abc" });
    const response = await callPublicConfig(env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      registrationMode: "invite",
      registrationAvailable: true,
      termsVersion: "2026-01-01",
      limits: {
        maxLibraryItemsPerAccount: 100,
        maxLibraryBytesPerAccount: 1_073_741_824,
        maxDevicesPerAccount: 5,
        maxActiveSessionsPerAccount: 10,
        maxPasskeysPerAccount: 5,
      },
      turnstileSiteKey: "site-key-abc",
    });
  });

  it("returns the expected shape for mode=open, with turnstileSiteKey null when unset", async () => {
    const env = buildEnv({ REGISTRATION_MODE: "open" });
    const response = await callPublicConfig(env);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.registrationMode).toBe("open");
    expect(body.registrationAvailable).toBe(true);
    expect(body.turnstileSiteKey).toBeNull();
  });

  it("returns registrationAvailable=false for mode=closed regardless of capacity", async () => {
    const env = buildEnv({ REGISTRATION_MODE: "closed", accountCount: 0, libraryBytes: 0 });
    const response = await callPublicConfig(env);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.registrationMode).toBe("closed");
    expect(body.registrationAvailable).toBe(false);
  });

  it("does not leak any secret, raw accountCount, internal R2 usage, or raw admin storage-percent thresholds", async () => {
    const env = buildEnv({
      REGISTRATION_MODE: "open",
      accountCount: 42,
      libraryBytes: 123_456,
      TURNSTILE_SECRET_KEY: "turnstile-secret-value",
      REGISTRATION_IP_PEPPER: "ip-pepper-value",
      INTERNAL_STATUS_SECRET: "internal-status-secret-value",
      SESSION_PEPPER: "session-pepper-value",
      TOTAL_STORAGE_WARNING_PERCENT: "80",
      TOTAL_STORAGE_STOP_PERCENT: "95",
    } as Partial<Env>);
    const response = await callPublicConfig(env);
    const rawBody = await response.text();

    for (const forbidden of [
      "turnstile-secret-value",
      "ip-pepper-value",
      "internal-status-secret-value",
      "session-pepper-value",
    ]) {
      expect(rawBody).not.toContain(forbidden);
    }

    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const topLevelKeys = Object.keys(body);
    expect(topLevelKeys.sort()).toEqual(
      ["registrationMode", "registrationAvailable", "termsVersion", "limits", "turnstileSiteKey"].sort(),
    );
    // No key named after a secret env var, the raw account count, or the
    // raw admin storage-percent thresholds (only the boolean composite
    // registrationAvailable is exposed).
    for (const forbiddenKey of SECRET_LEAK_KEYS) {
      expect(topLevelKeys).not.toContain(forbiddenKey);
    }
    expect(rawBody).not.toMatch(/TOTAL_STORAGE_(WARNING|STOP)_PERCENT/);
    expect(rawBody).not.toContain("accountCount");
    expect(rawBody).not.toContain("libraryBytes");
    expect(rawBody).not.toContain("R2");
  });

  describe("registrationAvailable composite judgement (mode=open)", () => {
    it("is true when under both the account cap and the storage stop threshold", async () => {
      const env = buildEnv({
        REGISTRATION_MODE: "open",
        MAX_TOTAL_ACCOUNTS: "500",
        MAX_TOTAL_LIBRARY_BYTES: "1000",
        TOTAL_STORAGE_STOP_PERCENT: "95",
        accountCount: 100,
        libraryBytes: 900, // stop threshold is 950; 900 < 950
      } as Partial<Env>);
      const body = (await (await callPublicConfig(env)).json()) as Record<string, unknown>;
      expect(body.registrationAvailable).toBe(true);
    });

    it("is false once the total-account cap is reached", async () => {
      const env = buildEnv({
        REGISTRATION_MODE: "open",
        MAX_TOTAL_ACCOUNTS: "500",
        accountCount: 500,
        libraryBytes: 0,
      } as Partial<Env>);
      const body = (await (await callPublicConfig(env)).json()) as Record<string, unknown>;
      expect(body.registrationAvailable).toBe(false);
    });

    it("is false once service-wide storage reaches the stop threshold", async () => {
      const env = buildEnv({
        REGISTRATION_MODE: "open",
        MAX_TOTAL_ACCOUNTS: "500",
        MAX_TOTAL_LIBRARY_BYTES: "1000",
        TOTAL_STORAGE_STOP_PERCENT: "95",
        accountCount: 0,
        libraryBytes: 950, // exactly at the stop threshold: not < stopBytes
      } as Partial<Env>);
      const body = (await (await callPublicConfig(env)).json()) as Record<string, unknown>;
      expect(body.registrationAvailable).toBe(false);
    });
  });
});
