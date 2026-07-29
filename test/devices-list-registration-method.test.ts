// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import type { Account } from "../src/auth/sessions";
import { listDevices } from "../src/devices/service";

/**
 * Phase2 spec §8.3 / §13.1 "一覧": GET /api/devices's DTO must surface
 * registrationMethod (for the WebUI badge) and must never surface
 * token/tokenHash — the column list itself already excludes token_hash
 * (src/devices/repository.ts's DEVICE_COLUMNS), this asserts the DTO layer
 * doesn't reintroduce it.
 */

const ACCOUNT: Account = { id: "acct-1", displayName: "Haruki" };

class FakeD1 {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.rows, sql);
  }
}

class FakeStatement {
  constructor(
    private readonly rows: Record<string, unknown>[],
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.rows, this.sql, args);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM devices WHERE account_id = ? AND status = 'active'")) {
      const [accountId] = this.args as [string];
      return { results: this.rows.filter((row) => row.account_id === accountId) as T[] };
    }
    throw new Error(`FakeD1: unhandled SQL in all(): ${this.sql}`);
  }
}

function deviceRow(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "dev-default",
    account_id: ACCOUNT.id,
    name: "Reader",
    status: "active",
    library_version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: null,
    revoked_at: null,
    device: null,
    width: null,
    height: null,
    registration_method: "pairing",
    ...overrides,
  };
}

describe("listDevices — registrationMethod", () => {
  it("surfaces registrationMethod for both pairing and manual_opds devices, never token/tokenHash", async () => {
    const db = new FakeD1([
      deviceRow({ id: "dev-paired", registration_method: "pairing" }),
      deviceRow({ id: "dev-manual", registration_method: "manual_opds", device: "x3", width: 528, height: 792 }),
    ]);

    const devices = await listDevices({ APP_DB: db as unknown as D1Database }, ACCOUNT);

    expect(devices.find((d) => d.id === "dev-paired")?.registrationMethod).toBe("pairing");
    expect(devices.find((d) => d.id === "dev-manual")?.registrationMethod).toBe("manual_opds");
    for (const device of devices) {
      expect(device).not.toHaveProperty("token");
      expect(device).not.toHaveProperty("tokenHash");
    }
  });
});
