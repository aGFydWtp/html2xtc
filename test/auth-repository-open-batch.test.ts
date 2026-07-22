// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  countAccountsCreatedSince,
  countSucceededRegistrationEventsForIpSince,
  countTotalAccounts,
  runOpenAccountRegistrationBatch,
} from "../src/auth/repository";

/**
 * Minimal in-memory fake of the four tables runOpenAccountRegistrationBatch
 * touches (accounts, webauthn_credentials, account_terms_acceptances,
 * registration_events) plus the read-only COUNT queries — narrow-fake
 * convention matching test/auth-repository-batch.test.ts (the invite-path
 * equivalent). Exercises the same atomicity guarantee: a credential_id
 * UNIQUE violation on the second statement must roll back the whole
 * db.batch(), including the account row the first statement created.
 */
class FakeD1 {
  accounts = new Map<string, { displayName: string; createdAt: string }>();
  credentialAccountIds = new Map<string, string>();
  termsAcceptances: { id: string; accountId: string; termsVersion: string; acceptedAt: string }[] = [];
  registrationEvents: { id: string; ipHash: string; status: string; createdAt: string; expiresAt: string }[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(stmts: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    const snapshot = {
      accounts: new Map(this.accounts),
      credentialAccountIds: new Map(this.credentialAccountIds),
      termsAcceptances: [...this.termsAcceptances],
      registrationEvents: [...this.registrationEvents],
    };
    try {
      const results: { meta: { changes: number } }[] = [];
      for (const stmt of stmts) {
        results.push(stmt.apply());
      }
      return results;
    } catch (error) {
      this.accounts = snapshot.accounts;
      this.credentialAccountIds = snapshot.credentialAccountIds;
      this.termsAcceptances = snapshot.termsAcceptances;
      this.registrationEvents = snapshot.registrationEvents;
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

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT COUNT(*) AS count FROM accounts WHERE created_at >= ?")) {
      const [sinceIso] = this.args as [string];
      const count = [...this.db.accounts.values()].filter((a) => a.createdAt >= sinceIso).length;
      return { count } as unknown as T;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM accounts")) {
      return { count: this.db.accounts.size } as unknown as T;
    }
    if (this.sql.includes("FROM registration_events")) {
      const [ipHash, sinceIso] = this.args as [string, string];
      const count = this.db.registrationEvents.filter(
        (e) => e.ipHash === ipHash && e.status === "succeeded" && e.createdAt >= sinceIso,
      ).length;
      return { count } as unknown as T;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  apply(): { meta: { changes: number } } {
    if (this.sql.includes("INSERT INTO accounts")) {
      const [id, displayName, createdAt] = this.args as [string, string, string, string];
      this.db.accounts.set(id, { displayName, createdAt });
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
    if (this.sql.includes("INSERT INTO account_terms_acceptances")) {
      const [id, accountId, termsVersion, acceptedAt] = this.args as [string, string, string, string];
      this.db.termsAcceptances.push({ id, accountId, termsVersion, acceptedAt });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO registration_events")) {
      const [id, ipHash, createdAt, expiresAt] = this.args as [string, string, string, string];
      this.db.registrationEvents.push({ id, ipHash, status: "succeeded", createdAt, expiresAt });
      return { meta: { changes: 1 } };
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

function batchParams(overrides: { accountId?: string; credentialId?: string; ipHash?: string } = {}) {
  const accountId = overrides.accountId ?? "acct-1";
  return {
    account: { id: accountId, displayName: "Haruki", createdAt: "2026-01-01T00:00:00.000Z" },
    credential: newCredential(overrides.credentialId ?? "cred-abc", accountId),
    termsAcceptance: { id: "terms-1", termsVersion: "2026-07-01", acceptedAt: "2026-01-01T00:00:00.000Z" },
    registrationEvent: {
      id: "event-1",
      ipHash: overrides.ipHash ?? "iphash-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-08T00:00:00.000Z",
    },
  };
}

describe("runOpenAccountRegistrationBatch", () => {
  it("commits account + credential + terms acceptance + registration event together on success", async () => {
    const db = new FakeD1();

    await runOpenAccountRegistrationBatch(db as unknown as D1Database, batchParams());

    expect(db.accounts.get("acct-1")?.displayName).toBe("Haruki");
    expect(db.credentialAccountIds.get("cred-abc")).toBe("acct-1");
    expect(db.termsAcceptances).toHaveLength(1);
    expect(db.termsAcceptances[0]).toMatchObject({ accountId: "acct-1", termsVersion: "2026-07-01" });
    expect(db.registrationEvents).toHaveLength(1);
    expect(db.registrationEvents[0]).toMatchObject({ ipHash: "iphash-1", status: "succeeded" });
  });

  it("rolls back the account, terms acceptance, and registration event when the credential insert fails (no orphan account)", async () => {
    const db = new FakeD1();
    // Simulates the passkey already being registered to a different account.
    db.credentialAccountIds.set("cred-abc", "other-account");

    await expect(runOpenAccountRegistrationBatch(db as unknown as D1Database, batchParams())).rejects.toThrow(
      /UNIQUE constraint/,
    );

    expect(db.accounts.has("acct-1")).toBe(false);
    expect(db.termsAcceptances).toHaveLength(0);
    expect(db.registrationEvents).toHaveLength(0);
  });
});

describe("countTotalAccounts / countAccountsCreatedSince / countSucceededRegistrationEventsForIpSince", () => {
  it("counts total accounts and accounts created since a cutoff", async () => {
    const db = new FakeD1();
    db.accounts.set("a", { displayName: "A", createdAt: "2026-01-01T00:00:00.000Z" });
    db.accounts.set("b", { displayName: "B", createdAt: "2026-01-10T00:00:00.000Z" });

    expect(await countTotalAccounts(db as unknown as D1Database)).toBe(2);
    expect(await countAccountsCreatedSince(db as unknown as D1Database, "2026-01-05T00:00:00.000Z")).toBe(1);
  });

  it("counts only succeeded registration_events for the given ip_hash at or after the cutoff", async () => {
    const db = new FakeD1();
    db.registrationEvents = [
      { id: "1", ipHash: "hash-a", status: "succeeded", createdAt: "2026-01-10T00:00:00.000Z", expiresAt: "x" },
      { id: "2", ipHash: "hash-a", status: "succeeded", createdAt: "2025-01-01T00:00:00.000Z", expiresAt: "x" }, // too old
      { id: "3", ipHash: "hash-b", status: "succeeded", createdAt: "2026-01-10T00:00:00.000Z", expiresAt: "x" }, // different IP
    ];

    const count = await countSucceededRegistrationEventsForIpSince(
      db as unknown as D1Database,
      "hash-a",
      "2026-01-05T00:00:00.000Z",
    );
    expect(count).toBe(1);
  });
});
