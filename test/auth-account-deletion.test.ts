// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { deleteAccountCompletely } from "../src/auth/account-deletion";

/**
 * 登録モード仕様 Phase1 §5.5 / §5.10: R2削除が失敗しても D1 のアカウント削除
 * (accounts行のDELETE) は必ず完遂し、失敗した R2 キーは orphaned_r2_objects
 * に記録されること。デバイスは削除前にrevokeされること。
 */

const ACCOUNT_ID = "acct-1";

interface LibraryRow {
  id: string;
  account_id: string;
  r2_key: string;
  deleted_at: string | null;
}
interface DeviceRow {
  id: string;
  account_id: string;
  status: string;
}
interface OrphanRow {
  r2_key: string;
  reason: string;
}

class FakeD1 {
  libraryItems: LibraryRow[] = [];
  devices: DeviceRow[] = [];
  orphans: OrphanRow[] = [];
  accountDeleted = false;

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

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM library_items")) {
      const [accountId] = this.args as [string];
      const rows = this.db.libraryItems.filter((r) => r.account_id === accountId && r.deleted_at === null);
      return { results: rows.map((r) => ({ ...r, created_at: "2026-01-01", updated_at: "2026-01-01" })) as unknown as T[] };
    }
    if (this.sql.includes("FROM devices")) {
      const [accountId] = this.args as [string];
      const rows = this.db.devices.filter((r) => r.account_id === accountId && r.status === "active");
      return {
        results: rows.map((r) => ({
          id: r.id,
          account_id: r.account_id,
          name: "device",
          status: r.status,
          library_version: 1,
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
          last_seen_at: null,
          revoked_at: null,
        })) as unknown as T[],
      };
    }
    throw new Error(`FakeD1: unhandled all() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("UPDATE devices SET status = 'revoked'")) {
      const [, , id, accountId] = this.args as [string, string, string, string];
      const device = this.db.devices.find((d) => d.id === id && d.account_id === accountId && d.status === "active");
      if (device === undefined) return { meta: { changes: 0 } };
      device.status = "revoked";
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO orphaned_r2_objects")) {
      const [, r2Key, reason] = this.args as [string, string, string];
      this.db.orphans.push({ r2_key: r2Key, reason });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("DELETE FROM accounts")) {
      this.db.accountDeleted = true;
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

class FakeR2Bucket {
  deletedKeys: string[] = [];
  constructor(private readonly failingKeys: Set<string> = new Set()) {}

  async delete(key: string): Promise<void> {
    if (this.failingKeys.has(key)) {
      throw new Error(`simulated R2 delete failure for ${key}`);
    }
    this.deletedKeys.push(key);
  }
}

describe("deleteAccountCompletely", () => {
  it("revokes devices, deletes R2 objects, and always deletes the D1 account row", async () => {
    const db = new FakeD1();
    db.libraryItems.push({ id: "item-1", account_id: ACCOUNT_ID, r2_key: "library/accounts/acct-1/items/item-1/book.xtc", deleted_at: null });
    db.devices.push({ id: "dev-1", account_id: ACCOUNT_ID, status: "active" });
    const bucket = new FakeR2Bucket();

    await deleteAccountCompletely({ APP_DB: db as unknown as D1Database, XTC_BUCKET: bucket as unknown as R2Bucket }, {
      id: ACCOUNT_ID,
      displayName: "Haruki",
    });

    expect(db.devices[0]?.status).toBe("revoked");
    expect(bucket.deletedKeys).toEqual(["library/accounts/acct-1/items/item-1/book.xtc"]);
    expect(db.accountDeleted).toBe(true);
    expect(db.orphans).toHaveLength(0);
  });

  it("records an orphaned_r2_objects row and still deletes the D1 account when R2 delete fails", async () => {
    const db = new FakeD1();
    const failingKey = "library/accounts/acct-1/items/item-1/book.xtc";
    db.libraryItems.push({ id: "item-1", account_id: ACCOUNT_ID, r2_key: failingKey, deleted_at: null });
    const bucket = new FakeR2Bucket(new Set([failingKey]));

    await deleteAccountCompletely({ APP_DB: db as unknown as D1Database, XTC_BUCKET: bucket as unknown as R2Bucket }, {
      id: ACCOUNT_ID,
      displayName: "Haruki",
    });

    expect(bucket.deletedKeys).toHaveLength(0);
    expect(db.orphans).toEqual([{ r2_key: failingKey, reason: "account_deletion_r2_delete_failed" }]);
    // The D1 deletion must complete regardless of the R2 failure.
    expect(db.accountDeleted).toBe(true);
  });
});
