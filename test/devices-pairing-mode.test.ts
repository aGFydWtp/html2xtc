// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it, vi } from "vitest";

// src/devices/routes.ts pulls in src/ratelimiter.ts, which imports
// DurableObject from cloudflare:workers at module top level — that only
// resolves under the real workerd runtime. Same stub as
// test/ratelimiter-scope-global.test.ts.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { registerDeviceRoutes } = await import("../src/devices/routes");
const { Router } = await import("../src/router");
type Env = import("../src/types").Env;

/**
 * 登録モード仕様 Phase3 §7: PAIRING_MODE ゲート — POST /api/device-pairings
 * (新規ペアリング開始)のみを止める。router 経由の統合テスト（PAIRING_MODE の
 * 判定は src/devices/routes.ts のハンドラ内、startPairing 呼び出し前にある
 * ため、router レベルでしか検証できない）。CF-Connecting-IP を付けないので
 * enforcePurposeRateLimit は毎回スキップされ、RATE_LIMITER binding は不要。
 */

class FakeD1 {
  pairings: { id: string; userCode: string }[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO device_pairings")) {
      const [id, userCode] = this.args as [string, string];
      this.db.pairings.push({ id, userCode });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

function buildEnv(db: FakeD1, extra: Record<string, string> = {}): Env {
  return {
    APP_DB: db as unknown as D1Database,
    WEBAUTHN_ORIGIN: "https://xtc.hr20k.com",
    ...extra,
  } as unknown as Env;
}

async function postPairingStart(env: Env): Promise<Response> {
  const router = new Router();
  registerDeviceRoutes(router);
  const response = await router.handle(
    new Request("https://example.com/api/device-pairings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  expect(response).not.toBeNull();
  return response as Response;
}

describe("POST /api/device-pairings — PAIRING_MODE gate", () => {
  it("rejects with 403 PAIRING_DISABLED and never creates a pairing row when disabled", async () => {
    const db = new FakeD1();
    const env = buildEnv(db, { PAIRING_MODE: "disabled" });

    const response = await postPairingStart(env);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAIRING_DISABLED");
    expect(db.pairings).toHaveLength(0);
  });

  it("allows starting a pairing when PAIRING_MODE is unset (default enabled — non-regression)", async () => {
    const db = new FakeD1();
    const env = buildEnv(db);

    const response = await postPairingStart(env);
    expect(response.status).toBe(201);
    expect(db.pairings).toHaveLength(1);
  });

  it("allows starting a pairing on an unrecognized PAIRING_MODE value (falls back to enabled)", async () => {
    const db = new FakeD1();
    const env = buildEnv(db, { PAIRING_MODE: "banana" });

    const response = await postPairingStart(env);
    expect(response.status).toBe(201);
    expect(db.pairings).toHaveLength(1);
  });

  it("allows starting a pairing when explicitly enabled", async () => {
    const db = new FakeD1();
    const env = buildEnv(db, { PAIRING_MODE: "enabled" });

    const response = await postPairingStart(env);
    expect(response.status).toBe(201);
    expect(db.pairings).toHaveLength(1);
  });
});
