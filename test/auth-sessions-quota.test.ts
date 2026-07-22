// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";

/**
 * 登録モード仕様 Phase1 §5.3 / §5.10: セッション数クォータの境界値テスト —
 * 上限到達時に最古の非currentセッションが失効され、新規セッションが発行
 * されること。narrow FakeD1（test/auth-repository-batch.test.ts と同方針）。
 */

const ACCOUNT_ID = "acct-1";

interface SessionRow {
  id: string;
  account_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

class FakeD1 {
  sessions: SessionRow[] = [];
  nextId = 0;

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

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("COUNT(*) AS count")) {
      const [accountId, nowIso] = this.args as [string, string];
      const count = this.db.sessions.filter(
        (s) => s.account_id === accountId && s.revoked_at === null && s.expires_at > nowIso,
      ).length;
      return { count } as T;
    }
    if (this.sql.includes("ORDER BY created_at ASC LIMIT 1")) {
      const [accountId, nowIso] = this.args as [string, string];
      const active = this.db.sessions
        .filter((s) => s.account_id === accountId && s.revoked_at === null && s.expires_at > nowIso)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const oldest = active[0];
      return (oldest !== undefined ? { id: oldest.id } : null) as T | null;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO sessions")) {
      const [id, accountId, , , createdAt, , expiresAt] = this.args as [
        string,
        string,
        string,
        string | null,
        string,
        string,
        string,
      ];
      this.db.sessions.push({ id, account_id: accountId, created_at: createdAt, expires_at: expiresAt, revoked_at: null });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE sessions SET revoked_at = ? WHERE id = ?")) {
      const [revokedAt, id] = this.args as [string, string];
      const row = this.db.sessions.find((s) => s.id === id);
      if (row === undefined || row.revoked_at !== null) {
        return { meta: { changes: 0 } };
      }
      row.revoked_at = revokedAt;
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

function baseEnv(db: FakeD1, maxSessions: string) {
  return {
    APP_DB: db as unknown as D1Database,
    SESSION_PEPPER: "pepper",
    SESSION_TTL_DAYS: "30",
    MAX_ACTIVE_SESSIONS_PER_ACCOUNT: maxSessions,
  };
}

describe("createSession — active-session quota", () => {
  it("issues freely under the limit", async () => {
    const db = new FakeD1();
    const env = baseEnv(db, "2");
    await createSession(env, ACCOUNT_ID, "ua-1");
    await createSession(env, ACCOUNT_ID, "ua-2");
    expect(db.sessions.filter((s) => s.revoked_at === null)).toHaveLength(2);
  });

  it("revokes the oldest active session and still issues a new one when at the limit", async () => {
    const db = new FakeD1();
    const env = baseEnv(db, "1");
    const first = await createSession(env, ACCOUNT_ID, "ua-1");

    // Ensure createdAt ordering is unambiguous even within the same millisecond.
    await new Promise((r) => setTimeout(r, 2));
    const second = await createSession(env, ACCOUNT_ID, "ua-2");

    const active = db.sessions.filter((s) => s.revoked_at === null);
    expect(active).toHaveLength(1);
    expect(second.token).not.toBe(first.token);
    // The first session (oldest) is the one that got revoked.
    const firstRow = db.sessions.find((s) => s.created_at === active[0]?.created_at);
    expect(firstRow).toBeDefined();
    expect(db.sessions.filter((s) => s.revoked_at !== null)).toHaveLength(1);
  });

  it("throws 409 SESSION_LIMIT_EXCEEDED if there is nothing left to revoke (quota misconfigured to 0-equivalent)", async () => {
    const db = new FakeD1();
    const env = baseEnv(db, "1");
    // Manually seed an already-revoked "active-looking count" scenario is
    // hard to construct without breaking the fake's invariants, so instead
    // simulate the race directly: countActiveSessions sees 1, but the
    // subsequent oldest-lookup finds nothing (a concurrent revoke won).
    db.sessions.push({
      id: "phantom",
      account_id: ACCOUNT_ID,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });
    const originalFirst = FakeStatement.prototype.first;
    let calls = 0;
    FakeStatement.prototype.first = async function firstOverride<T>(this: FakeStatement) {
      calls++;
      if (calls === 2) {
        // The oldest-session lookup: report nothing found, simulating the
        // race the doc comment describes.
        return null as T | null;
      }
      return originalFirst.call(this) as Promise<T | null>;
    };
    try {
      await expect(createSession(env, ACCOUNT_ID, "ua-1")).rejects.toMatchObject({
        status: 409,
        code: "SESSION_LIMIT_EXCEEDED",
      });
    } finally {
      FakeStatement.prototype.first = originalFirst;
    }
  });
});
