// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, describe, expect, it, vi } from "vitest";
import { recordOrphanedR2Object } from "../src/db/orphaned-r2";

class FakeD1 {
  inserted: { r2_key: string; reason: string }[] = [];
  shouldFail = false;

  prepare(): FakeStatement {
    return new FakeStatement(this);
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(private readonly db: FakeD1) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.db.shouldFail) {
      throw new Error("simulated D1 failure");
    }
    const [, r2Key, reason] = this.args as [string, string, string];
    this.db.inserted.push({ r2_key: r2Key, reason });
    return { meta: { changes: 1 } };
  }
}

describe("recordOrphanedR2Object", () => {
  afterEach(() => vi.restoreAllMocks());

  it("inserts a row with the key and reason", async () => {
    const db = new FakeD1();
    await recordOrphanedR2Object({ APP_DB: db as unknown as D1Database }, "library/accounts/x/items/y/book.xtc", "account_deletion_r2_delete_failed");
    expect(db.inserted).toEqual([
      { r2_key: "library/accounts/x/items/y/book.xtc", reason: "account_deletion_r2_delete_failed" },
    ]);
  });

  it("never throws even if the D1 insert itself fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new FakeD1();
    db.shouldFail = true;
    await expect(
      recordOrphanedR2Object({ APP_DB: db as unknown as D1Database }, "some/key", "reason"),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});
