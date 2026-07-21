// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { listDevicesForAccount } from "../src/devices/repository";

/**
 * Regression test for the token-rotation removal cleanup: listDevicesForAccount
 * now scopes its SELECT to `status = 'active'` so a revoked device (soft-deleted,
 * no un-revoke path) drops off the WebUI's device list instead of lingering
 * forever with a "解除済み" badge. This asserts both that the SQL still carries
 * the `status = 'active'` clause (FakeD1 throws on any other shape, same
 * convention as test/devices-library-version-bump.test.ts) and that, given a
 * mix of active/revoked rows for the account, only the active ones come back.
 */
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
    if (
      this.sql.includes("FROM devices WHERE account_id = ? AND status = 'active'") &&
      this.sql.includes("ORDER BY created_at DESC")
    ) {
      const [accountId] = this.args as [string];
      const results = this.rows
        .filter((row) => row.account_id === accountId && row.status === "active")
        .sort((a, b) => (b.created_at as string).localeCompare(a.created_at as string));
      return { results: results as T[] };
    }
    throw new Error(`FakeD1: unhandled SQL in all(): ${this.sql}`);
  }
}

function deviceRow(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "dev-default",
    account_id: "acct-1",
    name: "Reader",
    status: "active",
    library_version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe("listDevicesForAccount", () => {
  it("returns only active devices, excluding revoked ones, newest first", async () => {
    const db = new FakeD1([
      deviceRow({ id: "dev-old-active", account_id: "acct-1", status: "active", created_at: "2026-01-01T00:00:00.000Z" }),
      deviceRow({
        id: "dev-revoked",
        account_id: "acct-1",
        status: "revoked",
        created_at: "2026-01-02T00:00:00.000Z",
        revoked_at: "2026-01-03T00:00:00.000Z",
      }),
      deviceRow({ id: "dev-new-active", account_id: "acct-1", status: "active", created_at: "2026-01-03T00:00:00.000Z" }),
      // Different account entirely — must never leak into acct-1's list.
      deviceRow({ id: "dev-other-account", account_id: "acct-2", status: "active", created_at: "2026-01-04T00:00:00.000Z" }),
    ]);

    const result = await listDevicesForAccount(db as unknown as D1Database, "acct-1");

    expect(result.map((d) => d.id)).toEqual(["dev-new-active", "dev-old-active"]);
    expect(result.every((d) => d.status === "active")).toBe(true);
  });

  it("returns an empty array when every device for the account has been revoked", async () => {
    const db = new FakeD1([deviceRow({ id: "dev-1", account_id: "acct-1", status: "revoked", revoked_at: "2026-01-02T00:00:00.000Z" })]);

    const result = await listDevicesForAccount(db as unknown as D1Database, "acct-1");

    expect(result).toEqual([]);
  });
});
