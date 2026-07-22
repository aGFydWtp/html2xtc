// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { registerInternalRoutes } from "../src/internal/routes";
import { Router } from "../src/router";
import type { Env } from "../src/types";

/**
 * 登録モード仕様 Phase2 §10: GET /internal/registration/status. Covers the
 * fail-closed shared-secret auth (PHASE2_REVIEW.md Medium #1): unset
 * secret, mismatched header, missing header, and matching header, plus the
 * 200 response's expected fields.
 *
 * Narrow FakeD1 scoped to exactly the three queries the handler issues
 * (COUNT(*) FROM accounts, COUNT(*) FROM accounts WHERE created_at >= ?,
 * SUM(size_bytes) FROM library_items) — same narrow-fake convention as
 * test/public-config.test.ts / test/db-cleanup.test.ts.
 */
class FakeD1 {
  constructor(
    readonly accountCount: number,
    readonly accountsCreatedToday: number,
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
    if (this.sql.includes("FROM accounts") && this.sql.includes("WHERE created_at")) {
      return { count: this.db.accountsCreatedToday } as unknown as T;
    }
    if (this.sql.includes("FROM accounts")) {
      return { count: this.db.accountCount } as unknown as T;
    }
    if (this.sql.includes("FROM library_items")) {
      return { total: this.db.libraryBytes } as unknown as T;
    }
    throw new Error(`FakeD1: unexpected SQL: ${this.sql}`);
  }
}

function buildEnv(overrides: Partial<Env> = {}, dbCounts: { accountCount?: number; accountsCreatedToday?: number; libraryBytes?: number } = {}): Env {
  const db = new FakeD1(dbCounts.accountCount ?? 0, dbCounts.accountsCreatedToday ?? 0, dbCounts.libraryBytes ?? 0);
  return {
    APP_DB: db,
    ...overrides,
  } as unknown as Env;
}

async function callInternalStatus(env: Env, headers?: Record<string, string>): Promise<Response> {
  const router = new Router();
  registerInternalRoutes(router);
  const response = await router.handle(
    new Request("https://example.com/internal/registration/status", { headers }),
    env,
  );
  expect(response).not.toBeNull();
  return response as Response;
}

describe("GET /internal/registration/status auth (fail-closed)", () => {
  it("returns 401 when INTERNAL_STATUS_SECRET is unset, even with a header present", async () => {
    const env = buildEnv({});
    const response = await callInternalStatus(env, { "X-Internal-Status-Secret": "anything" });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when INTERNAL_STATUS_SECRET is set to an empty string", async () => {
    const env = buildEnv({ INTERNAL_STATUS_SECRET: "" });
    const response = await callInternalStatus(env, { "X-Internal-Status-Secret": "" });
    expect(response.status).toBe(401);
  });

  it("returns 401 when the header value does not match the configured secret", async () => {
    const env = buildEnv({ INTERNAL_STATUS_SECRET: "correct-secret" });
    const response = await callInternalStatus(env, { "X-Internal-Status-Secret": "wrong-secret" });
    expect(response.status).toBe(401);
  });

  it("returns 401 when the header is missing entirely", async () => {
    const env = buildEnv({ INTERNAL_STATUS_SECRET: "correct-secret" });
    const response = await callInternalStatus(env);
    expect(response.status).toBe(401);
  });

  it("returns 401 when the header value has a different length than the secret (timingSafeEqual length-mismatch path)", async () => {
    const env = buildEnv({ INTERNAL_STATUS_SECRET: "correct-secret" });
    const response = await callInternalStatus(env, { "X-Internal-Status-Secret": "short" });
    expect(response.status).toBe(401);
  });

  it("returns 200 when the header exactly matches the configured secret", async () => {
    const env = buildEnv({ INTERNAL_STATUS_SECRET: "correct-secret" });
    const response = await callInternalStatus(env, { "X-Internal-Status-Secret": "correct-secret" });
    expect(response.status).toBe(200);
  });
});

describe("GET /internal/registration/status response body", () => {
  it("returns the expected capacity/health fields on success", async () => {
    const env = buildEnv(
      {
        INTERNAL_STATUS_SECRET: "correct-secret",
        MAX_TOTAL_ACCOUNTS: "500",
        MAX_NEW_ACCOUNTS_PER_DAY: "50",
        MAX_TOTAL_LIBRARY_BYTES: "53687091200",
      },
      { accountCount: 12, accountsCreatedToday: 3, libraryBytes: 4096 },
    );
    const response = await callInternalStatus(env, { "X-Internal-Status-Secret": "correct-secret" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      accountCount: 12,
      maxAccounts: 500,
      accountsCreatedToday: 3,
      maxNewAccountsPerDay: 50,
      libraryBytes: 4096,
      maxTotalLibraryBytes: 53687091200,
    });
  });

  it("falls back to default limits when the corresponding env vars are unset", async () => {
    const env = buildEnv({ INTERNAL_STATUS_SECRET: "correct-secret" }, {});
    const response = await callInternalStatus(env, { "X-Internal-Status-Secret": "correct-secret" });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.maxAccounts).toBe(500);
    expect(body.maxNewAccountsPerDay).toBe(50);
    expect(body.maxTotalLibraryBytes).toBe(53_687_091_200);
  });
});
