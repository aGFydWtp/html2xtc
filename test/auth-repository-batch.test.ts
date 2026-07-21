// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { runNewAccountRegistrationBatch } from "../src/auth/repository";

/**
 * Minimal in-memory fake of the three tables runNewAccountRegistrationBatch
 * touches (registration_invites, accounts, webauthn_credentials), just
 * faithful enough to exercise the atomicity guarantee the review asked for
 * (finding M3 / task item 3): a credential_id UNIQUE violation on the third
 * statement must roll back the whole db.batch(), including the invite
 * consumption and account creation the first two statements performed —
 * otherwise a used invite + zero-credential "orphan" account is left behind.
 * No existing test in this repo mocks D1 (see test/auth-repository.test.ts
 * and friends — every other test here exercises pure functions only), so
 * this fake is deliberately scoped to exactly the SQL shapes
 * src/auth/repository.ts issues rather than a general D1 emulator.
 */
class FakeD1 {
  invites = new Map<string, string | null>(); // id -> consumedAt
  accounts = new Map<string, string>(); // id -> displayName
  credentialAccountIds = new Map<string, string>(); // credentialId -> accountId

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(stmts: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    const snapshot = {
      invites: new Map(this.invites),
      accounts: new Map(this.accounts),
      credentialAccountIds: new Map(this.credentialAccountIds),
    };
    try {
      const results: { meta: { changes: number } }[] = [];
      for (const stmt of stmts) {
        results.push(stmt.apply());
      }
      return results;
    } catch (error) {
      this.invites = snapshot.invites;
      this.accounts = snapshot.accounts;
      this.credentialAccountIds = snapshot.credentialAccountIds;
      throw error;
    }
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
    return this.apply();
  }

  apply(): { meta: { changes: number } } {
    if (this.sql.includes("UPDATE registration_invites")) {
      const [consumedAt, id] = this.args as [string, string];
      const current = this.db.invites.get(id);
      if (current === undefined || current !== null) {
        return { meta: { changes: 0 } };
      }
      this.db.invites.set(id, consumedAt);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO accounts")) {
      const [id, displayName] = this.args as [string, string, string, string];
      this.db.accounts.set(id, displayName);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO webauthn_credentials")) {
      const [, accountId, credentialId] = this.args as [string, string, string];
      if (this.db.credentialAccountIds.has(credentialId)) {
        throw new Error("UNIQUE constraint failed: webauthn_credentials.credential_id");
      }
      this.db.credentialAccountIds.set(credentialId, accountId);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("DELETE FROM accounts")) {
      const [id] = this.args as [string];
      const existed = this.db.accounts.delete(id);
      return { meta: { changes: existed ? 1 : 0 } };
    }
    throw new Error(`FakeD1: unhandled SQL: ${this.sql}`);
  }
}

function newCredential(credentialId: string, accountId: string) {
  return {
    id: "cred-row-id",
    accountId,
    credentialId,
    publicKey: new Uint8Array([1, 2, 3]),
    signCount: 0,
    transports: null,
    deviceType: null,
    backedUp: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("runNewAccountRegistrationBatch", () => {
  it("commits invite consumption + account + credential together on success", async () => {
    const db = new FakeD1();
    db.invites.set("invite-1", null);

    const result = await runNewAccountRegistrationBatch(db as unknown as D1Database, {
      invite: { id: "invite-1", consumedAt: "2026-01-01T00:00:00.000Z" },
      account: { id: "acct-1", displayName: "Haruki", createdAt: "2026-01-01T00:00:00.000Z" },
      credential: newCredential("cred-abc", "acct-1"),
    });

    expect(result.inviteConsumed).toBe(true);
    expect(db.invites.get("invite-1")).toBe("2026-01-01T00:00:00.000Z");
    expect(db.accounts.get("acct-1")).toBe("Haruki");
    expect(db.credentialAccountIds.get("cred-abc")).toBe("acct-1");
  });

  it("rolls back the invite consumption and account creation when the credential insert fails (no orphan account)", async () => {
    const db = new FakeD1();
    db.invites.set("invite-1", null);
    // Simulates the passkey already being registered to a different account.
    db.credentialAccountIds.set("cred-abc", "other-account");

    await expect(
      runNewAccountRegistrationBatch(db as unknown as D1Database, {
        invite: { id: "invite-1", consumedAt: "2026-01-01T00:00:00.000Z" },
        account: { id: "acct-1", displayName: "Haruki", createdAt: "2026-01-01T00:00:00.000Z" },
        credential: newCredential("cred-abc", "acct-1"),
      }),
    ).rejects.toThrow(/UNIQUE constraint/);

    // Nothing must be left behind: no orphan account, invite still usable.
    expect(db.accounts.has("acct-1")).toBe(false);
    expect(db.invites.get("invite-1")).toBeNull();
  });

  it("reports inviteConsumed: false when a concurrent request already consumed the invite", async () => {
    const db = new FakeD1();
    db.invites.set("invite-1", "2025-01-01T00:00:00.000Z"); // already consumed by a racing request

    const result = await runNewAccountRegistrationBatch(db as unknown as D1Database, {
      invite: { id: "invite-1", consumedAt: "2026-01-01T00:00:00.000Z" },
      account: { id: "acct-1", displayName: "Haruki", createdAt: "2026-01-01T00:00:00.000Z" },
      credential: newCredential("cred-abc", "acct-1"),
    });

    // D1 batch() can't make the account/credential inserts conditional on
    // the invite UPDATE's affected-row count, so they land anyway — the
    // caller (finishRegistration) is responsible for noticing
    // inviteConsumed === false and deleting the account it just created.
    expect(result.inviteConsumed).toBe(false);
    expect(db.accounts.has("acct-1")).toBe(true);
  });
});
