// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { bumpLibraryVersionForDevices } from "../src/devices/repository";
import { removeItemFromAllDeviceLibraries } from "../src/library/repository";

/**
 * Review finding L3 / task item 7: deleting a library item detaches it from
 * every device's list (device_library_items) but previously left each
 * affected device's library_version untouched, so a DeviceLibraryEditor left
 * open on one of those devices would keep offering a now-stale
 * expectedVersion instead of hitting the 409 VERSION_CONFLICT reload path.
 * These tests cover the two new primitives src/library/service.ts's
 * deleteLibrary composes: removeItemFromAllDeviceLibraries (now returns the
 * distinct device_ids it actually detached from) and
 * bumpLibraryVersionForDevices (bumps exactly those devices by 1).
 *
 * Fake D1 scoped to just the SQL these two functions issue, same convention
 * as test/auth-repository-batch.test.ts — no existing test in this repo
 * mocks D1 beyond that.
 */
class FakeD1 {
  // device_library_items rows: libraryItemId -> Set<deviceId>
  assignments = new Map<string, Set<string>>();
  // devices: deviceId -> libraryVersion
  libraryVersions = new Map<string, number>();

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(stmts: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    return stmts.map((stmt) => stmt.apply());
  }
}

class FakeStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  // Real D1PreparedStatement.bind() returns a distinct bound statement
  // rather than mutating in place — production code (e.g.
  // bumpLibraryVersionForDevices) relies on that by preparing one statement
  // and calling .bind() on it once per row, so this fake must do the same
  // or every "bound" copy would alias the same args array.
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("DELETE FROM device_library_items") && this.sql.includes("RETURNING device_id")) {
      const [itemId] = this.args as [string];
      const deviceIds = [...(this.db.assignments.get(itemId) ?? new Set<string>())];
      this.db.assignments.delete(itemId);
      return { results: deviceIds.map((deviceId) => ({ device_id: deviceId })) as T[] };
    }
    throw new Error(`FakeD1: unhandled SQL in all(): ${this.sql}`);
  }

  apply(): { meta: { changes: number } } {
    if (this.sql.includes("UPDATE devices SET library_version = library_version + 1")) {
      const [, deviceId] = this.args as [string, string];
      const current = this.db.libraryVersions.get(deviceId);
      if (current === undefined) {
        return { meta: { changes: 0 } };
      }
      this.db.libraryVersions.set(deviceId, current + 1);
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled SQL in apply(): ${this.sql}`);
  }
}

describe("removeItemFromAllDeviceLibraries", () => {
  it("returns the distinct device_ids the item was assigned to, and clears the assignment", async () => {
    const db = new FakeD1();
    db.assignments.set("item-1", new Set(["dev-a", "dev-b"]));

    const affected = await removeItemFromAllDeviceLibraries(db as unknown as D1Database, "item-1");

    expect(new Set(affected)).toEqual(new Set(["dev-a", "dev-b"]));
    expect(db.assignments.has("item-1")).toBe(false);
  });

  it("returns an empty array when the item wasn't assigned to any device", async () => {
    const db = new FakeD1();
    const affected = await removeItemFromAllDeviceLibraries(db as unknown as D1Database, "item-unassigned");
    expect(affected).toEqual([]);
  });
});

describe("bumpLibraryVersionForDevices", () => {
  it("increments library_version by exactly 1 for each given device", async () => {
    const db = new FakeD1();
    db.libraryVersions.set("dev-a", 3);
    db.libraryVersions.set("dev-b", 7);
    db.libraryVersions.set("dev-c", 1); // not in the list — must stay untouched

    await bumpLibraryVersionForDevices(db as unknown as D1Database, ["dev-a", "dev-b"], "2026-01-01T00:00:00.000Z");

    expect(db.libraryVersions.get("dev-a")).toBe(4);
    expect(db.libraryVersions.get("dev-b")).toBe(8);
    expect(db.libraryVersions.get("dev-c")).toBe(1);
  });

  it("is a no-op for an empty device list (no batch call issued)", async () => {
    const db = new FakeD1();
    // No devices registered at all — if this issued any statement it would
    // throw "unhandled SQL", so a clean resolve proves the early return.
    await expect(bumpLibraryVersionForDevices(db as unknown as D1Database, [], "2026-01-01T00:00:00.000Z"))
      .resolves.toBeUndefined();
  });
});
