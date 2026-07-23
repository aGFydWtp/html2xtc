// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import type { Account } from "../src/auth/sessions";
import { autoAddItemToSoleActiveDevice } from "../src/devices/service";

/**
 * Spec: "ライブラリ保存時、アクティブ端末がちょうど1台なら、その端末の配信
 * リストにも自動で追加する" — autoAddItemToSoleActiveDevice is the piece
 * src/library/routes.ts calls after a genuine new-item save (never on the
 * idempotent-replay path, which is why this function itself never re-checks
 * "was this a new save" — that's the caller's job).
 *
 * FakeD1 models exactly the three tables this flow touches (devices,
 * library_items, device_library_items) end-to-end, reusing the real
 * replaceDeviceLibrary/getDeviceLibrary/listDevicesForAccount code paths so
 * the version-bump and position-renumbering logic under test is the actual
 * production logic, not a re-implementation of it.
 */

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
}

interface LibraryItemRow {
  id: string;
  account_id: string;
  title: string;
  author: string | null;
  size_bytes: number;
  deleted_at: string | null;
}

interface DeviceLibraryItemRow {
  device_id: string;
  library_item_id: string;
  position: number;
  added_at: string;
}

class FakeD1 {
  devices: DeviceRow[] = [];
  libraryItems: LibraryItemRow[] = [];
  deviceLibraryItems: DeviceLibraryItemRow[] = [];
  /** When set, the next library_version UPDATE throws instead of running — simulates a D1 error mid-write. */
  failNextVersionUpdate = false;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    const results: { meta: { changes: number } }[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
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
    if (this.sql.includes("FROM devices WHERE id = ? AND account_id = ?")) {
      const [deviceId, accountId] = this.args as [string, string];
      const row = this.db.devices.find((d) => d.id === deviceId && d.account_id === accountId);
      return (row ?? null) as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM library_items")) {
      const [accountId, ...itemIds] = this.args as [string, ...string[]];
      const count = this.db.libraryItems.filter(
        (item) => item.account_id === accountId && item.deleted_at === null && itemIds.includes(item.id),
      ).length;
      return { count } as T;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM devices WHERE account_id = ? AND status = 'active'")) {
      const accountId = this.args[0] as string;
      const results = this.db.devices.filter(
        (d) => d.account_id === accountId && d.status === "active",
      ) as unknown as T[];
      return { results };
    }
    if (this.sql.includes("FROM device_library_items dli")) {
      const deviceId = this.args[0] as string;
      const rows = this.db.deviceLibraryItems
        .filter((dli) => dli.device_id === deviceId)
        .map((dli) => {
          const item = this.db.libraryItems.find((li) => li.id === dli.library_item_id);
          if (item === undefined || item.deleted_at !== null) {
            return null;
          }
          return {
            id: item.id,
            title: item.title,
            author: item.author,
            size_bytes: item.size_bytes,
            position: dli.position,
            added_at: dli.added_at,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((a, b) => a.position - b.position) as unknown as T[];
      return { results: rows };
    }
    throw new Error(`FakeD1: unhandled all() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("UPDATE devices SET library_version = library_version + 1")) {
      if (this.db.failNextVersionUpdate) {
        this.db.failNextVersionUpdate = false;
        throw new Error("simulated D1 error during library_version update");
      }
      const [updatedAt, deviceId, accountId, expectedVersion] = this.args as [string, string, string, number];
      const device = this.db.devices.find(
        (d) => d.id === deviceId && d.account_id === accountId && d.library_version === expectedVersion,
      );
      if (device === undefined) {
        return { meta: { changes: 0 } };
      }
      device.library_version += 1;
      device.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("DELETE FROM device_library_items WHERE device_id = ?")) {
      const deviceId = this.args[0] as string;
      this.db.deviceLibraryItems = this.db.deviceLibraryItems.filter((dli) => dli.device_id !== deviceId);
      return { meta: { changes: 0 } };
    }
    if (this.sql.includes("INSERT INTO device_library_items")) {
      const [deviceId, libraryItemId, position, addedAt] = this.args as [string, string, number, string];
      this.db.deviceLibraryItems.push({
        device_id: deviceId,
        library_item_id: libraryItemId,
        position,
        added_at: addedAt,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

const ACCOUNT: Account = { id: "acct-1", displayName: "Haruki" };
const NEW_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const EXISTING_ITEM_ID = "22222222-2222-4222-8222-222222222222";

function deviceRow(id: string, overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id,
    account_id: ACCOUNT.id,
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

function libraryItemRow(id: string, overrides: Partial<LibraryItemRow> = {}): LibraryItemRow {
  return {
    id,
    account_id: ACCOUNT.id,
    title: "A Book",
    author: null,
    size_bytes: 100,
    deleted_at: null,
    ...overrides,
  };
}

describe("autoAddItemToSoleActiveDevice", () => {
  it("(a) adds the new item to the sole active device's delivery list, at the end", async () => {
    const db = new FakeD1();
    db.devices.push(deviceRow("dev-1", { library_version: 3 }));
    db.libraryItems.push(libraryItemRow(EXISTING_ITEM_ID), libraryItemRow(NEW_ITEM_ID, { title: "New Book" }));
    db.deviceLibraryItems.push({
      device_id: "dev-1",
      library_item_id: EXISTING_ITEM_ID,
      position: 0,
      added_at: "2026-01-01T00:00:00.000Z",
    });
    const env = { APP_DB: db as unknown as D1Database };

    await autoAddItemToSoleActiveDevice(env, ACCOUNT, NEW_ITEM_ID);

    const entries = db.deviceLibraryItems.filter((dli) => dli.device_id === "dev-1");
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.library_item_id === NEW_ITEM_ID)?.position).toBe(1);
    expect(db.devices[0].library_version).toBe(4);
  });

  it("(a) adds the item as the only entry when the device's list was empty", async () => {
    const db = new FakeD1();
    db.devices.push(deviceRow("dev-1"));
    db.libraryItems.push(libraryItemRow(NEW_ITEM_ID));
    const env = { APP_DB: db as unknown as D1Database };

    await autoAddItemToSoleActiveDevice(env, ACCOUNT, NEW_ITEM_ID);

    expect(db.deviceLibraryItems).toEqual([
      expect.objectContaining({ device_id: "dev-1", library_item_id: NEW_ITEM_ID, position: 0 }),
    ]);
    expect(db.devices[0].library_version).toBe(2);
  });

  it("(b) does nothing when the account has zero active devices", async () => {
    const db = new FakeD1();
    db.libraryItems.push(libraryItemRow(NEW_ITEM_ID));
    const env = { APP_DB: db as unknown as D1Database };

    await autoAddItemToSoleActiveDevice(env, ACCOUNT, NEW_ITEM_ID);

    expect(db.deviceLibraryItems).toHaveLength(0);
  });

  it("(b) does nothing when the account has two or more active devices", async () => {
    const db = new FakeD1();
    db.devices.push(deviceRow("dev-1"), deviceRow("dev-2"));
    db.libraryItems.push(libraryItemRow(NEW_ITEM_ID));
    const env = { APP_DB: db as unknown as D1Database };

    await autoAddItemToSoleActiveDevice(env, ACCOUNT, NEW_ITEM_ID);

    expect(db.deviceLibraryItems).toHaveLength(0);
    expect(db.devices.every((d) => d.library_version === 1)).toBe(true);
  });

  it("ignores a revoked device — only status='active' devices count toward the 'exactly one' rule", async () => {
    const db = new FakeD1();
    db.devices.push(deviceRow("dev-1", { status: "revoked" }));
    db.libraryItems.push(libraryItemRow(NEW_ITEM_ID));
    const env = { APP_DB: db as unknown as D1Database };

    await autoAddItemToSoleActiveDevice(env, ACCOUNT, NEW_ITEM_ID);

    expect(db.deviceLibraryItems).toHaveLength(0);
  });

  it("does nothing when the item is already in the sole device's delivery list (no duplicate insert)", async () => {
    const db = new FakeD1();
    db.devices.push(deviceRow("dev-1", { library_version: 5 }));
    db.libraryItems.push(libraryItemRow(NEW_ITEM_ID));
    db.deviceLibraryItems.push({
      device_id: "dev-1",
      library_item_id: NEW_ITEM_ID,
      position: 0,
      added_at: "2026-01-01T00:00:00.000Z",
    });
    const env = { APP_DB: db as unknown as D1Database };

    await autoAddItemToSoleActiveDevice(env, ACCOUNT, NEW_ITEM_ID);

    expect(db.deviceLibraryItems).toHaveLength(1);
    // No version bump either — replaceDeviceLibrary was never called.
    expect(db.devices[0].library_version).toBe(5);
  });

  it("(d) swallows a failure (e.g. a D1 error during the version bump) instead of throwing, so the caller's library save still succeeds", async () => {
    const db = new FakeD1();
    db.devices.push(deviceRow("dev-1"));
    db.libraryItems.push(libraryItemRow(NEW_ITEM_ID));
    db.failNextVersionUpdate = true;
    const env = { APP_DB: db as unknown as D1Database };

    await expect(autoAddItemToSoleActiveDevice(env, ACCOUNT, NEW_ITEM_ID)).resolves.toBeUndefined();

    expect(db.deviceLibraryItems).toHaveLength(0);
    expect(db.devices[0].library_version).toBe(1);
  });
});
