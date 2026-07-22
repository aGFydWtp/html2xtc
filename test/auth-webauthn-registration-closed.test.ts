// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode, sha256Hex } from "../src/security/crypto";

/**
 * 登録モード仕様 Phase3 §3: finishRegistration の closed 拒否。
 *   - challenge は必ず consumeChallenge の「後」に拒否する（拒否時も
 *     challenge は消費済みで再利用不可 — PHASE3_GAP_ANALYSIS.md §6 risk 1）。
 *   - new-account(invite) / open-account は拒否、add-credential(既存
 *     アカウントへの追加パスキー)は closed でも常に許可する。
 *   - 拒否時に auth.registration.blocked 監査イベントを1件だけ出す。
 *
 * verifyRegistrationResponse のモックは test/auth-webauthn-open-registration
 * .test.ts と同じ理由（実クレデンシャルの署名検証は一切扱わない）。
 */
vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-abc",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: undefined,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    })),
  };
});

const { startRegistration, finishRegistration } = await import("../src/auth/webauthn");

interface InviteRow {
  id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
}

class FakeD1 {
  invites: InviteRow[] = [];
  accounts = new Map<string, { displayName: string; createdAt: string }>();
  credentialAccountIds = new Map<string, string>();
  challenges = new Map<string, { id: string; metadataJson: string | null; expiresAt: string; consumedAt: string | null }>();
  sessions: { accountId: string }[] = [];
  registrationEvents: { ipHash: string }[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(stmts: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    return stmts.map((stmt) => stmt.apply());
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

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM webauthn_credentials WHERE account_id = ?")) {
      return { results: [] as T[] };
    }
    throw new Error(`FakeD1: unhandled all() query: ${this.sql}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM registration_invites")) {
      const [tokenHash] = this.args as [string];
      const row = this.db.invites.find((invite) => invite.token_hash === tokenHash);
      return row === undefined
        ? null
        : ({ id: row.id, expires_at: row.expires_at, consumed_at: row.consumed_at } as unknown as T);
    }
    if (this.sql.includes("SELECT id, account_id, metadata_json, expires_at, consumed_at")) {
      const [challengeHash] = this.args as [string];
      const row = this.db.challenges.get(challengeHash);
      return row === undefined
        ? null
        : ({
            id: row.id,
            account_id: null,
            metadata_json: row.metadataJson,
            expires_at: row.expiresAt,
            consumed_at: row.consumedAt,
          } as unknown as T);
    }
    if (this.sql.includes("SELECT id, display_name FROM accounts WHERE id = ?")) {
      const [id] = this.args as [string];
      const row = this.db.accounts.get(id);
      return row === undefined ? null : ({ id, display_name: row.displayName } as unknown as T);
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM accounts")) {
      return { count: this.db.accounts.size } as unknown as T;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  apply(): { meta: { changes: number } } {
    if (this.sql.includes("INSERT INTO auth_challenges")) {
      const [, , , challengeHash, metadataJson, expiresAt] = this.args as [
        string,
        string,
        string | null,
        string,
        string | null,
        string,
        string,
      ];
      this.db.challenges.set(challengeHash, { id: challengeHash, metadataJson, expiresAt, consumedAt: null });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE auth_challenges SET consumed_at")) {
      const [consumedAt, id] = this.args as [string, string];
      const row = [...this.db.challenges.values()].find((c) => c.id === id);
      if (row === undefined || row.consumedAt !== null) {
        return { meta: { changes: 0 } };
      }
      row.consumedAt = consumedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE registration_invites SET consumed_at")) {
      const [consumedAt, id] = this.args as [string, string];
      const row = this.db.invites.find((invite) => invite.id === id);
      if (row === undefined || row.consumed_at !== null) {
        return { meta: { changes: 0 } };
      }
      row.consumed_at = consumedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO accounts")) {
      const [id, displayName, createdAt] = this.args as [string, string, string, string];
      this.db.accounts.set(id, { displayName, createdAt });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO webauthn_credentials")) {
      const [, accountId, credentialId] = this.args as [string, string, string];
      this.db.credentialAccountIds.set(credentialId, accountId);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO account_terms_acceptances")) {
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO registration_events")) {
      const [, ipHash] = this.args as [string, string, string, string];
      this.db.registrationEvents.push({ ipHash });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO sessions")) {
      const [, accountId] = this.args as [string, string];
      this.db.sessions.push({ accountId });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled SQL: ${this.sql}`);
  }
}

function baseEnv(db: FakeD1, extra: Record<string, string> = {}) {
  return {
    APP_DB: db as unknown as D1Database,
    WEBAUTHN_RP_ID: "xtc.hr20k.com",
    WEBAUTHN_ORIGIN: "https://xtc.hr20k.com",
    SESSION_PEPPER: "session-pepper",
    SESSION_TTL_DAYS: "30",
    ...extra,
  };
}

async function clientDataJSONFor(challenge: string): Promise<string> {
  const json = JSON.stringify({ type: "webauthn.create", challenge, origin: "https://xtc.hr20k.com" });
  return base64UrlEncode(new TextEncoder().encode(json));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finishRegistration — REGISTRATION_MODE=closed rejects new-account (invite)", () => {
  it("rejects with 403 REGISTRATION_CLOSED, consumes the challenge, creates no account, and does not consume the invite", async () => {
    const db = new FakeD1();
    db.invites.push({
      id: "invite-1",
      token_hash: await sha256Hex("tok-123"),
      expires_at: "2999-01-01T00:00:00.000Z",
      consumed_at: null,
    });
    // options is issued while mode is still "invite" (the realistic case:
    // the client got its options before an operator flipped the switch).
    const options = await startRegistration(baseEnv(db), {
      invite: { inviteToken: "tok-123", displayName: "Haruki" },
    });
    const response = {
      id: "cred-abc",
      rawId: "cred-abc",
      response: { clientDataJSON: await clientDataJSONFor(options.challenge) },
      clientExtensionResults: {},
      type: "public-key",
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      finishRegistration(baseEnv(db, { REGISTRATION_MODE: "closed" }), response as never, "UA/1.0", "203.0.113.7"),
    ).rejects.toMatchObject({ status: 403, code: "REGISTRATION_CLOSED" });

    // No account/credential created, invite still unused.
    expect(db.accounts.size).toBe(0);
    expect(db.credentialAccountIds.size).toBe(0);
    expect(db.invites[0]?.consumed_at).toBeNull();

    // The challenge was consumed (burned) despite the rejection — cannot be replayed.
    const challengeRow = [...db.challenges.values()][0];
    expect(challengeRow?.consumedAt).not.toBeNull();

    // Exactly one auth.registration.blocked audit line, with mode/reason only.
    const blockedLines = logSpy.mock.calls
      .map(([line]) => JSON.parse(line as string))
      .filter((entry) => entry.event === "auth.registration.blocked");
    expect(blockedLines).toHaveLength(1);
    expect(blockedLines[0]).toMatchObject({ mode: "closed", reason: "unset" });
  });

  it("a second finishRegistration attempt with the same (already-burned) challenge fails as REGISTRATION_FAILED, not REGISTRATION_CLOSED (proves the challenge cannot be replayed even back in a permissive mode)", async () => {
    const db = new FakeD1();
    db.invites.push({
      id: "invite-1",
      token_hash: await sha256Hex("tok-456"),
      expires_at: "2999-01-01T00:00:00.000Z",
      consumed_at: null,
    });
    const options = await startRegistration(baseEnv(db), {
      invite: { inviteToken: "tok-456", displayName: "Haruki" },
    });
    const response = {
      id: "cred-abc",
      rawId: "cred-abc",
      response: { clientDataJSON: await clientDataJSONFor(options.challenge) },
      clientExtensionResults: {},
      type: "public-key",
    };

    await expect(
      finishRegistration(baseEnv(db, { REGISTRATION_MODE: "closed" }), response as never, "UA/1.0", null),
    ).rejects.toMatchObject({ status: 403, code: "REGISTRATION_CLOSED" });

    // Replaying the same response, even once mode is back to "invite", must
    // not succeed (the challenge itself is already burned).
    await expect(
      finishRegistration(baseEnv(db), response as never, "UA/1.0", null),
    ).rejects.toMatchObject({ status: 400, code: "REGISTRATION_FAILED" });
  });
});

describe("finishRegistration — REGISTRATION_MODE=closed rejects open-account", () => {
  it("rejects with 403 REGISTRATION_CLOSED and creates no account, even though options was issued while mode was 'open'", async () => {
    const db = new FakeD1();
    const options = await startRegistration(baseEnv(db, { REGISTRATION_MODE: "open" }), {
      open: { displayName: "Haruki", termsVersion: "2026-07-01" },
    });
    const response = {
      id: "cred-abc",
      rawId: "cred-abc",
      response: { clientDataJSON: await clientDataJSONFor(options.challenge) },
      clientExtensionResults: {},
      type: "public-key",
    };

    await expect(
      finishRegistration(
        baseEnv(db, { REGISTRATION_MODE: "closed", MAX_TOTAL_ACCOUNTS: "500", REGISTRATION_IP_PEPPER: "ip-pepper" }),
        response as never,
        "UA/1.0",
        "203.0.113.7",
      ),
    ).rejects.toMatchObject({ status: 403, code: "REGISTRATION_CLOSED" });

    expect(db.accounts.size).toBe(0);
    expect(db.registrationEvents).toHaveLength(0);
  });
});

describe("finishRegistration — REGISTRATION_MODE=closed never blocks add-credential", () => {
  it("still adds the passkey to the existing (already-authenticated) account and returns no new session", async () => {
    const db = new FakeD1();
    db.accounts.set("acct-1", { displayName: "Haruki", createdAt: "2026-01-01T00:00:00.000Z" });
    const options = await startRegistration(baseEnv(db, { REGISTRATION_MODE: "closed" }), {
      existingAccount: { id: "acct-1", displayName: "Haruki" },
    });
    const response = {
      id: "cred-abc",
      rawId: "cred-abc",
      response: { clientDataJSON: await clientDataJSONFor(options.challenge) },
      clientExtensionResults: {},
      type: "public-key",
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await finishRegistration(baseEnv(db, { REGISTRATION_MODE: "closed" }), response as never, "UA/1.0", null);

    expect(result.session).toBeNull();
    expect(result.account.id).toBe("acct-1");
    expect(db.credentialAccountIds.get("cred-abc")).toBe("acct-1");

    // No auth.registration.blocked audit line for the allowed add-credential path.
    const blockedLines = logSpy.mock.calls
      .map(([line]) => JSON.parse(line as string))
      .filter((entry) => entry.event === "auth.registration.blocked");
    expect(blockedLines).toHaveLength(0);
  });
});
