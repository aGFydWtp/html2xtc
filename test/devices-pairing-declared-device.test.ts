// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it, vi } from "vitest";

// Same stub as test/devices-pairing-mode.test.ts — src/devices/routes.ts pulls
// in src/ratelimiter.ts, which imports DurableObject from cloudflare:workers
// at module top level, only resolvable under the real workerd runtime.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { registerDeviceRoutes } = await import("../src/devices/routes");
const { Router } = await import("../src/router");
const { approvePairingForAccount } = await import("../src/devices/pairings");
type Env = import("../src/types").Env;

/**
 * End-to-end coverage for migrations/app/0006_pairing_declared_device.sql:
 * the deviceModel/width/height crosspoint-jp's firmware now sends on
 * POST /api/device-pairings, from request body -> normalization
 * (src/devices/declared-device.ts) -> device_pairings row -> (on approval)
 * devices row. Every case must leave pairing itself unaffected (still 201 /
 * still approvable) — this is a fail-soft passthrough, never a validation
 * gate.
 */

interface PairingInsertArgs {
  id: string;
  userCode: string;
  requestedDevice: unknown;
  requestedWidth: unknown;
  requestedHeight: unknown;
}

class PairingStartFakeD1 {
  inserted: PairingInsertArgs[] = [];

  prepare(sql: string): PairingStartFakeStatement {
    return new PairingStartFakeStatement(this, sql);
  }
}

class PairingStartFakeStatement {
  private args: unknown[] = [];
  constructor(
    private readonly db: PairingStartFakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): PairingStartFakeStatement {
    this.args = args;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO device_pairings")) {
      // bind order: id, userCode, pairingSecretHash, requestedName,
      // createdAt, expiresAt, requestedDevice, requestedWidth,
      // requestedHeight (src/devices/repository.ts's insertPairing).
      const [id, userCode, , , , , requestedDevice, requestedWidth, requestedHeight] = this.args as [
        string,
        string,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
      ];
      this.db.inserted.push({ id, userCode, requestedDevice, requestedWidth, requestedHeight });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

function buildEnv(db: PairingStartFakeD1): Env {
  return {
    APP_DB: db as unknown as D1Database,
    WEBAUTHN_ORIGIN: "https://xtc.hr20k.com",
  } as unknown as Env;
}

async function postPairingStart(env: Env, body: Record<string, unknown>): Promise<Response> {
  const router = new Router();
  registerDeviceRoutes(router);
  const response = await router.handle(
    new Request("https://example.com/api/device-pairings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  expect(response).not.toBeNull();
  return response as Response;
}

describe("POST /api/device-pairings — deviceModel/width/height passthrough", () => {
  it("legacy firmware sending only requestedName stores all-null device fields (non-regression)", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), { requestedName: "Xteink" });
    expect(response.status).toBe(201);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({ requestedDevice: null, requestedWidth: null, requestedHeight: null });
  });

  it("stores a well-formed x3 declaration", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), {
      requestedName: "Xteink X3",
      deviceModel: "x3",
      width: 528,
      height: 792,
    });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedDevice: "x3", requestedWidth: 528, requestedHeight: 792 });
  });

  it("stores a well-formed x4 declaration", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), {
      requestedName: "Xteink X4",
      deviceModel: "x4",
      width: 480,
      height: 800,
    });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedDevice: "x4", requestedWidth: 480, requestedHeight: 800 });
  });

  it("an unknown deviceModel nulls the device but pairing still succeeds (no 400)", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), { deviceModel: "x9", width: 600, height: 900 });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedDevice: null, requestedWidth: 600, requestedHeight: 900 });
  });

  it("a type-mismatched deviceModel (number) nulls the device without a 400", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), { deviceModel: 3 });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedDevice: null, requestedWidth: null, requestedHeight: null });
  });

  it("width only (missing height) nulls both dimensions without a 400", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), { deviceModel: "x3", width: 528 });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedDevice: "x3", requestedWidth: null, requestedHeight: null });
  });

  it("height only (missing width) nulls both dimensions without a 400", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), { deviceModel: "x3", height: 792 });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedDevice: "x3", requestedWidth: null, requestedHeight: null });
  });

  it("a negative dimension nulls both without a 400", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), { width: -528, height: 792 });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedWidth: null, requestedHeight: null });
  });

  it("a non-integer dimension nulls both without a 400", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), { width: 528.5, height: 792 });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedWidth: null, requestedHeight: null });
  });

  it("an implausibly large dimension nulls both without a 400", async () => {
    const db = new PairingStartFakeD1();
    const response = await postPairingStart(buildEnv(db), { width: 528, height: 1_000_000 });
    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({ requestedWidth: null, requestedHeight: null });
  });
});

// ---------------------------------------------------------------------------
// approvePairingForAccount: device_pairings.requested_* -> devices.* handoff
// ---------------------------------------------------------------------------

interface ApprovalDeviceRow {
  id: string;
  account_id: string;
  status: string;
  device: unknown;
  width: unknown;
  height: unknown;
}

function pairingEncryptionKey(): string {
  const bytes = new Uint8Array(32).fill(7);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

class ApprovalFakeD1 {
  devices: ApprovalDeviceRow[] = [];
  constructor(public readonly pairingRow: Record<string, unknown>) {}

  prepare(sql: string): ApprovalFakeStatement {
    return new ApprovalFakeStatement(this, sql);
  }
}

class ApprovalFakeStatement {
  private args: unknown[] = [];
  constructor(
    private readonly db: ApprovalFakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): ApprovalFakeStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM device_pairings")) {
      return this.db.pairingRow as unknown as T;
    }
    if (this.sql.includes("COUNT(*) AS count")) {
      return { count: 0 } as T;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO devices")) {
      // bind order: id, accountId, name, tokenHash, createdAt (x2 for
      // created_at/updated_at), device, width, height
      // (src/devices/repository.ts's insertDevice).
      const [id, accountId, , , , , device, width, height] = this.args as [
        string,
        string,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
      ];
      this.db.devices.push({
        id: id as string,
        account_id: accountId as string,
        status: "active",
        device,
        width,
        height,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE device_pairings")) {
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

function pendingPairingRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "pairing-1",
    user_code: "ABCD-2345",
    pairing_secret_hash: "unused",
    requested_name: null,
    status: "pending",
    account_id: null,
    device_id: null,
    encrypted_device_token: null,
    token_iv: null,
    token_auth_tag: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    approved_at: null,
    completed_at: null,
    requested_device: null,
    requested_width: null,
    requested_height: null,
    ...overrides,
  };
}

describe("approvePairingForAccount — declared device passthrough to devices", () => {
  it("carries an x3 declaration from the pairing row into the new device row", async () => {
    const pairingRow = pendingPairingRow({ requested_device: "x3", requested_width: 528, requested_height: 792 });
    const db = new ApprovalFakeD1(pairingRow);
    const env = {
      APP_DB: db as unknown as D1Database,
      PAIRING_ENCRYPTION_KEY: pairingEncryptionKey(),
      MAX_DEVICES_PER_ACCOUNT: "5",
    };

    const device = await approvePairingForAccount(env, { id: "acct-1", displayName: "Haruki" }, "pairing-1", "New Device");

    expect(device).toMatchObject({ device: "x3", width: 528, height: 792 });
    expect(db.devices[0]).toMatchObject({ device: "x3", width: 528, height: 792 });
  });

  it("carries an all-null (undeclared) pairing into an all-null device row (legacy firmware, non-regression)", async () => {
    const pairingRow = pendingPairingRow({});
    const db = new ApprovalFakeD1(pairingRow);
    const env = {
      APP_DB: db as unknown as D1Database,
      PAIRING_ENCRYPTION_KEY: pairingEncryptionKey(),
      MAX_DEVICES_PER_ACCOUNT: "5",
    };

    const device = await approvePairingForAccount(env, { id: "acct-1", displayName: "Haruki" }, "pairing-1", "New Device");

    expect(device).toMatchObject({ device: null, width: null, height: null });
    expect(db.devices[0]).toMatchObject({ device: null, width: null, height: null });
  });
});
