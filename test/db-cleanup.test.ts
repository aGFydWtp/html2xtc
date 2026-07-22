// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupAppDb } from "../src/db/cleanup";

/**
 * Minimal in-memory fake of the four tables cleanupAppDb touches
 * (auth_challenges, device_pairings, sessions, registration_invites),
 * scoped to exactly the DELETE shapes src/db/cleanup.ts issues — same
 * narrow-fake convention as test/auth-repository-batch.test.ts and
 * test/library-service-idempotent-save.test.ts (no existing test in this
 * repo drives a real D1 instance).
 *
 * Row timestamps are plain ISO-8601 strings compared lexically, exactly as
 * SQLite compares its TEXT columns, so string fixtures below double as the
 * production WHERE-clause semantics.
 */
interface AuthChallengeRow {
  id: string;
  expiresAt: string;
  consumedAt: string | null;
}
interface DevicePairingRow {
  id: string;
  expiresAt: string;
  status: string;
  completedAt: string | null;
  createdAt: string;
}
interface SessionRow {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
}
interface RegistrationInviteRow {
  id: string;
  expiresAt: string;
  consumedAt: string | null;
}
interface RegistrationEventRow {
  id: string;
  expiresAt: string;
}

class FakeD1 {
  authChallenges: AuthChallengeRow[] = [];
  devicePairings: DevicePairingRow[] = [];
  sessions: SessionRow[] = [];
  registrationInvites: RegistrationInviteRow[] = [];
  registrationEvents: RegistrationEventRow[] = [];
  /** Set to force the next matching table's DELETE to throw, simulating a D1 outage. */
  failTable:
    | "auth_challenges"
    | "device_pairings"
    | "sessions"
    | "registration_invites"
    | "registration_events"
    | null = null;

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
    if (this.sql.includes("FROM auth_challenges")) {
      if (this.db.failTable === "auth_challenges") {
        throw new Error("D1 unavailable");
      }
      const [nowIso] = this.args as [string];
      const before = this.db.authChallenges.length;
      this.db.authChallenges = this.db.authChallenges.filter(
        (row) => !(row.consumedAt !== null || row.expiresAt < nowIso),
      );
      return { meta: { changes: before - this.db.authChallenges.length } };
    }

    if (this.sql.includes("FROM device_pairings")) {
      if (this.db.failTable === "device_pairings") {
        throw new Error("D1 unavailable");
      }
      const [nowIso, retentionCutoffIso] = this.args as [string, string];
      const before = this.db.devicePairings.length;
      this.db.devicePairings = this.db.devicePairings.filter((row) => {
        const stale =
          row.expiresAt < nowIso ||
          (["completed", "rejected", "expired"].includes(row.status) &&
            (row.completedAt ?? row.createdAt) < retentionCutoffIso);
        return !stale;
      });
      return { meta: { changes: before - this.db.devicePairings.length } };
    }

    if (this.sql.includes("FROM sessions")) {
      if (this.db.failTable === "sessions") {
        throw new Error("D1 unavailable");
      }
      const [nowIso, revokedCutoffIso] = this.args as [string, string];
      const before = this.db.sessions.length;
      this.db.sessions = this.db.sessions.filter((row) => {
        const stale = row.expiresAt < nowIso || (row.revokedAt !== null && row.revokedAt < revokedCutoffIso);
        return !stale;
      });
      return { meta: { changes: before - this.db.sessions.length } };
    }

    if (this.sql.includes("FROM registration_invites")) {
      if (this.db.failTable === "registration_invites") {
        throw new Error("D1 unavailable");
      }
      const [nowIso, consumedCutoffIso] = this.args as [string, string];
      const before = this.db.registrationInvites.length;
      this.db.registrationInvites = this.db.registrationInvites.filter((row) => {
        const stale =
          (row.expiresAt < nowIso && row.consumedAt === null) ||
          (row.consumedAt !== null && row.consumedAt < consumedCutoffIso);
        return !stale;
      });
      return { meta: { changes: before - this.db.registrationInvites.length } };
    }

    if (this.sql.includes("FROM registration_events")) {
      if (this.db.failTable === "registration_events") {
        throw new Error("D1 unavailable");
      }
      const [nowIso] = this.args as [string];
      const before = this.db.registrationEvents.length;
      this.db.registrationEvents = this.db.registrationEvents.filter((row) => !(row.expiresAt < nowIso));
      return { meta: { changes: before - this.db.registrationEvents.length } };
    }

    throw new Error(`FakeD1: unhandled SQL: ${this.sql}`);
  }
}

const NOW = new Date("2026-07-21T18:30:00.000Z");

describe("cleanupAppDb", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("deletes expired-or-consumed auth_challenges, keeps live ones", async () => {
    const db = new FakeD1();
    db.authChallenges = [
      { id: "expired", expiresAt: "2026-07-01T00:00:00.000Z", consumedAt: null },
      { id: "consumed-but-unexpired", expiresAt: "2026-08-01T00:00:00.000Z", consumedAt: "2026-07-20T00:00:00.000Z" },
      { id: "live", expiresAt: "2026-08-01T00:00:00.000Z", consumedAt: null },
    ];

    const counts = await cleanupAppDb({ APP_DB: db as unknown as D1Database }, NOW);

    expect(counts.authChallenges).toBe(2);
    expect(db.authChallenges.map((r) => r.id)).toEqual(["live"]);
  });

  it("deletes any device_pairings row past its own expires_at regardless of status (token must never outlive expiry)", async () => {
    const db = new FakeD1();
    db.devicePairings = [
      // 'approved' with a lapsed expires_at: still deleted — the plan's
      // explicit guarantee that encrypted_device_token never survives past
      // expires_at wins over "the device might still be polling".
      {
        id: "approved-lapsed",
        expiresAt: "2026-07-21T18:00:00.000Z",
        status: "approved",
        completedAt: null,
        createdAt: "2026-07-21T17:50:00.000Z",
      },
      // still within its expiry window: kept.
      {
        id: "pending-live",
        expiresAt: "2026-07-21T18:35:00.000Z",
        status: "pending",
        completedAt: null,
        createdAt: "2026-07-21T18:25:00.000Z",
      },
    ];

    const counts = await cleanupAppDb({ APP_DB: db as unknown as D1Database }, NOW);

    expect(counts.devicePairings).toBe(1);
    expect(db.devicePairings.map((r) => r.id)).toEqual(["pending-live"]);
  });

  it("sweeps completed/rejected/expired device_pairings once past the 7-day retention window, even if expires_at is (hypothetically) still in the future", async () => {
    const db = new FakeD1();
    db.devicePairings = [
      // completed 8 days ago, expires_at unrealistically left in the future —
      // isolates the retention-window clause from the expires_at clause.
      {
        id: "old-completed",
        expiresAt: "2027-01-01T00:00:00.000Z",
        status: "completed",
        completedAt: "2026-07-13T00:00:00.000Z",
        createdAt: "2026-07-12T23:50:00.000Z",
      },
      // rejected only 1 day ago: kept.
      {
        id: "recent-rejected",
        expiresAt: "2027-01-01T00:00:00.000Z",
        status: "rejected",
        completedAt: null,
        createdAt: "2026-07-20T00:00:00.000Z",
      },
    ];

    const counts = await cleanupAppDb({ APP_DB: db as unknown as D1Database }, NOW);

    expect(counts.devicePairings).toBe(1);
    expect(db.devicePairings.map((r) => r.id)).toEqual(["recent-rejected"]);
  });

  it("deletes expired or long-revoked sessions, keeps live and recently-revoked ones", async () => {
    const db = new FakeD1();
    db.sessions = [
      { id: "expired", expiresAt: "2026-07-01T00:00:00.000Z", revokedAt: null },
      { id: "revoked-old", expiresAt: "2026-08-01T00:00:00.000Z", revokedAt: "2026-06-01T00:00:00.000Z" },
      { id: "revoked-recent", expiresAt: "2026-08-01T00:00:00.000Z", revokedAt: "2026-07-20T00:00:00.000Z" },
      { id: "live", expiresAt: "2026-08-01T00:00:00.000Z", revokedAt: null },
    ];

    const counts = await cleanupAppDb({ APP_DB: db as unknown as D1Database }, NOW);

    expect(counts.sessions).toBe(2);
    expect(db.sessions.map((r) => r.id).sort()).toEqual(["live", "revoked-recent"]);
  });

  it("deletes expired-unconsumed and long-consumed registration_invites, keeps live and recently-consumed ones", async () => {
    const db = new FakeD1();
    db.registrationInvites = [
      { id: "expired-unused", expiresAt: "2026-07-01T00:00:00.000Z", consumedAt: null },
      { id: "consumed-old", expiresAt: "2026-08-01T00:00:00.000Z", consumedAt: "2026-06-01T00:00:00.000Z" },
      { id: "consumed-recent", expiresAt: "2026-08-01T00:00:00.000Z", consumedAt: "2026-07-20T00:00:00.000Z" },
      { id: "live", expiresAt: "2026-08-01T00:00:00.000Z", consumedAt: null },
    ];

    const counts = await cleanupAppDb({ APP_DB: db as unknown as D1Database }, NOW);

    expect(counts.registrationInvites).toBe(2);
    expect(db.registrationInvites.map((r) => r.id).sort()).toEqual(["consumed-recent", "live"]);
  });

  it("deletes registration_events rows past their own expires_at, keeps live ones (登録モード仕様 Phase2 §4b, no separate retention window — expires_at is set at insert time)", async () => {
    const db = new FakeD1();
    db.registrationEvents = [
      { id: "expired", expiresAt: "2026-07-01T00:00:00.000Z" },
      { id: "live", expiresAt: "2026-08-01T00:00:00.000Z" },
    ];

    const counts = await cleanupAppDb({ APP_DB: db as unknown as D1Database }, NOW);

    expect(counts.registrationEvents).toBe(1);
    expect(db.registrationEvents.map((r) => r.id)).toEqual(["live"]);
  });

  it("logs a single app_db.cleanup.completed audit event with per-table counts and no secrets", async () => {
    const db = new FakeD1();
    db.authChallenges = [{ id: "a", expiresAt: "2026-07-01T00:00:00.000Z", consumedAt: null }];

    await cleanupAppDb({ APP_DB: db as unknown as D1Database }, NOW);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(logged.event).toBe("app_db.cleanup.completed");
    expect(logged.authChallenges).toBe(1);
    expect(logged.devicePairings).toBe(0);
    expect(logged.sessions).toBe(0);
    expect(logged.registrationInvites).toBe(0);
    expect(logged.registrationEvents).toBe(0);
    expect(logged).not.toHaveProperty("deviceToken");
    expect(logged).not.toHaveProperty("pairingSecret");
  });

  it("isolates a single table's D1 failure: other tables still clean up, failed one reports 0, and it never throws", async () => {
    const db = new FakeD1();
    db.failTable = "sessions";
    db.authChallenges = [{ id: "a", expiresAt: "2026-07-01T00:00:00.000Z", consumedAt: null }];
    db.sessions = [{ id: "s", expiresAt: "2026-07-01T00:00:00.000Z", revokedAt: null }];

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const counts = await cleanupAppDb({ APP_DB: db as unknown as D1Database }, NOW);
    errorSpy.mockRestore();

    expect(counts.authChallenges).toBe(1);
    expect(counts.sessions).toBe(0);
    // The row that failed to delete is still there (D1 "failed").
    expect(db.sessions).toHaveLength(1);
  });
});
