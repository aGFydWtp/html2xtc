// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { deleteCredentialById } from "../src/auth/repository";

/** 登録モード仕様 Phase1 §5.6 / §5.10: deleteCredentialById の account_id スコープ確認。 */

interface CredRow {
  id: string;
  account_id: string;
}

class FakeD1 {
  rows: CredRow[] = [];

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
    if (this.sql.includes("DELETE FROM webauthn_credentials")) {
      const [id, accountId] = this.args as [string, string];
      const before = this.db.rows.length;
      this.db.rows = this.db.rows.filter((r) => !(r.id === id && r.account_id === accountId));
      return { meta: { changes: before - this.db.rows.length } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

describe("deleteCredentialById", () => {
  it("deletes a credential owned by the given account", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "acct-1" });
    const deleted = await deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-1");
    expect(deleted).toBe(true);
    expect(db.rows).toHaveLength(0);
  });

  it("refuses to delete a credential owned by a different account", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "other-account" });
    const deleted = await deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-1");
    expect(deleted).toBe(false);
    expect(db.rows).toHaveLength(1);
  });

  it("returns false for an unknown credential id", async () => {
    const db = new FakeD1();
    const deleted = await deleteCredentialById(db as unknown as D1Database, "acct-1", "nope");
    expect(deleted).toBe(false);
  });
});
