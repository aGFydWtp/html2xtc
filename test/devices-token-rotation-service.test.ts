// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import type { Account } from "../src/auth/sessions";
import { verifyDeviceToken } from "../src/devices/credentials";
import { rotateDeviceToken } from "../src/devices/service";

/**
 * Phase2 spec §8.2 / §13.1 "token rotation". FakeD1 models exactly what
 * rotateDeviceToken touches: requireOwnedDevice's SELECT (getDeviceById) and
 * the conditional UPDATE devices SET token_hash (updateDeviceTokenHash).
 */

const ACCOUNT: Account = { id: "acct-1", displayName: "Haruki" };
const OTHER_ACCOUNT: Account = { id: "acct-2", displayName: "Someone Else" };

interface DeviceRow {
  id: string;
  account_id: string;
  name: string;
  status: string;
  library_version: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  device: string | null;
  width: number | null;
  height: number | null;
  registration_method: string;
  token_hash: string;
}

function deviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: "dev-1",
    account_id: ACCOUNT.id,
    name: "Xteink X3",
    status: "active",
    library_version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: null,
    revoked_at: null,
    device: "x3",
    width: 528,
    height: 792,
    registration_method: "manual_opds",
    token_hash: "old-hash",
    ...overrides,
  };
}

class FakeD1 {
  constructor(private readonly device: DeviceRow | null) {}

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

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT") && this.sql.includes("FROM devices WHERE id = ? AND account_id = ?")) {
      const [deviceId, accountId] = this.args as [string, string];
      const device = (this.db as unknown as { device: DeviceRow | null }).device;
      if (device === null || device.id !== deviceId || device.account_id !== accountId) {
        return null;
      }
      return device as unknown as T;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("UPDATE devices SET token_hash")) {
      const [tokenHash, updatedAt, deviceId, accountId] = this.args as [string, string, string, string];
      const device = (this.db as unknown as { device: DeviceRow | null }).device;
      if (device === null || device.id !== deviceId || device.account_id !== accountId || device.status !== "active") {
        return { meta: { changes: 0 } };
      }
      device.token_hash = tokenHash;
      device.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

function makeEnv(db: FakeD1) {
  return { APP_DB: db as unknown as D1Database };
}

describe("rotateDeviceToken", () => {
  it("issues a new token that verifies against the newly stored hash, invalidating the old hash", async () => {
    const row = deviceRow();
    const db = new FakeD1(row);

    const result = await rotateDeviceToken(makeEnv(db), ACCOUNT, "dev-1");

    expect(result.device.status).toBe("active");
    expect(row.token_hash).not.toBe("old-hash");
    expect(await verifyDeviceToken(result.token, row.token_hash)).toBe(true);
    // The (fictitious) old token can no longer verify against the now-rotated hash.
    expect(await verifyDeviceToken("whatever-the-old-plaintext-was", row.token_hash)).toBe(false);
  });

  it("rejects with 404 DEVICE_NOT_FOUND when the device doesn't exist", async () => {
    const db = new FakeD1(null);
    await expect(rotateDeviceToken(makeEnv(db), ACCOUNT, "dev-missing")).rejects.toMatchObject({
      status: 404,
      code: "DEVICE_NOT_FOUND",
    });
  });

  it("rejects with 404 DEVICE_NOT_FOUND (not 403) when the device belongs to another account", async () => {
    const row = deviceRow({ account_id: OTHER_ACCOUNT.id });
    const db = new FakeD1(row);
    await expect(rotateDeviceToken(makeEnv(db), ACCOUNT, "dev-1")).rejects.toMatchObject({
      status: 404,
      code: "DEVICE_NOT_FOUND",
    });
    expect(row.token_hash).toBe("old-hash");
  });

  it("rejects with 409 DEVICE_REVOKED for a revoked device, without touching token_hash", async () => {
    const row = deviceRow({ status: "revoked" });
    const db = new FakeD1(row);
    await expect(rotateDeviceToken(makeEnv(db), ACCOUNT, "dev-1")).rejects.toMatchObject({
      status: 409,
      code: "DEVICE_REVOKED",
    });
    expect(row.token_hash).toBe("old-hash");
  });
});
