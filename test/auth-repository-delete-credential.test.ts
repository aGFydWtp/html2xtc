// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { credentialExistsForAccount, deleteCredentialById } from "../src/auth/repository";

/**
 * 登録モード仕様 Phase1 §5.6 / §5.10: deleteCredentialById の account_id
 * スコープ確認、および PHASE1_REVIEW.md §High の修正確認 — 「最後の1本は
 * 削除不可」が count-then-delete ではなく単一の原子的 DELETE 文
 * (WHERE ... AND (SELECT COUNT(*) ...) > 1) になっていること。FakeStatement
 * の run() はこのサブクエリ付き DELETE の意味論をそのまま再現しており、
 * 実装が別クエリの count-then-delete に退行すればこのテストは失敗する
 * （SQL文字列に対する素朴なフィルタしか実装していないので、確認は
 * "結果の振る舞い" ベース）。
 */

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
      // Mirrors deleteCredentialById's real statement: DELETE ... WHERE
      // id = ? AND account_id = ? AND (SELECT COUNT(*) ... account_id = ?) > 1
      // — bound as (id, accountId, accountId).
      const [id, accountId, countAccountId] = this.args as [string, string, string];
      const remainingForAccount = this.db.rows.filter((r) => r.account_id === countAccountId).length;
      if (remainingForAccount <= 1) {
        // Would leave the account with zero passkeys — the whole statement
        // matches no row, exactly like the real correlated-subquery WHERE
        // clause.
        return { meta: { changes: 0 } };
      }
      const before = this.db.rows.length;
      this.db.rows = this.db.rows.filter((r) => !(r.id === id && r.account_id === accountId));
      return { meta: { changes: before - this.db.rows.length } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT 1 FROM webauthn_credentials")) {
      const [id, accountId] = this.args as [string, string];
      const exists = this.db.rows.some((r) => r.id === id && r.account_id === accountId);
      return exists ? ({ ["1"]: 1 } as unknown as T) : null;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }
}

describe("deleteCredentialById", () => {
  it("deletes a credential owned by the given account when another passkey remains", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "acct-1" });
    db.rows.push({ id: "cred-2", account_id: "acct-1" });
    const deleted = await deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-1");
    expect(deleted).toBe(true);
    expect(db.rows).toEqual([{ id: "cred-2", account_id: "acct-1" }]);
  });

  it("refuses to delete a credential owned by a different account", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "other-account" });
    const deleted = await deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-1");
    expect(deleted).toBe(false);
    expect(db.rows).toHaveLength(1);
  });

  it("returns false for an unknown credential id even when the account has multiple passkeys", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "acct-1" });
    db.rows.push({ id: "cred-2", account_id: "acct-1" });
    const deleted = await deleteCredentialById(db as unknown as D1Database, "acct-1", "nope");
    expect(deleted).toBe(false);
    expect(db.rows).toHaveLength(2);
  });

  it("refuses to delete the account's last remaining passkey", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "acct-1" });
    const deleted = await deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-1");
    expect(deleted).toBe(false);
    expect(db.rows).toEqual([{ id: "cred-1", account_id: "acct-1" }]);
  });

  it("never leaves an account passkey-less: deleting the second-to-last is fine, then deleting the last is refused", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "acct-1" });
    db.rows.push({ id: "cred-2", account_id: "acct-1" });

    expect(await deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-1")).toBe(true);
    expect(await deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-2")).toBe(false);
    expect(db.rows).toEqual([{ id: "cred-2", account_id: "acct-1" }]);
  });

  it("PHASE1_REVIEW.md §High regression guard: under concurrent delete attempts on a 2-passkey account, only one succeeds and at least one passkey always remains", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "acct-1" });
    db.rows.push({ id: "cred-2", account_id: "acct-1" });

    const [resultA, resultB] = await Promise.all([
      deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-1"),
      deleteCredentialById(db as unknown as D1Database, "acct-1", "cred-2"),
    ]);

    // Before the fix, a count-then-delete race let both of these resolve
    // true, leaving the account with zero passkeys (a permanent lockout on
    // this WebAuthn-only service). The atomic conditional DELETE guarantees
    // exactly one wins.
    expect([resultA, resultB].filter(Boolean)).toHaveLength(1);
    expect(db.rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("credentialExistsForAccount", () => {
  it("returns true when the credential exists for that account", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "acct-1" });
    expect(await credentialExistsForAccount(db as unknown as D1Database, "acct-1", "cred-1")).toBe(true);
  });

  it("returns false when the credential belongs to a different account", async () => {
    const db = new FakeD1();
    db.rows.push({ id: "cred-1", account_id: "other-account" });
    expect(await credentialExistsForAccount(db as unknown as D1Database, "acct-1", "cred-1")).toBe(false);
  });

  it("returns false when the credential id is unknown", async () => {
    const db = new FakeD1();
    expect(await credentialExistsForAccount(db as unknown as D1Database, "acct-1", "nope")).toBe(false);
  });
});
