// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it, vi } from "vitest";
import { base64UrlDecode, base64UrlEncode, sha256Hex } from "../src/security/crypto";

/**
 * 登録モード仕様 Phase2 §5.1/§7: startRegistration's open (invite-less)
 * branch, finishRegistration's open-account branch, and a regression guard
 * for §7's explicit scope decision "招待経路のuserNameは現状のまま一切変え
 * ない" — every branch shares the same generateRegistrationOptions call, so
 * this pins down that only the open branch's userName changed shape.
 *
 * finishRegistration's WebAuthn signature verification
 * (verifyRegistrationResponse) is mocked — same rationale as every other
 * test in this repo that never drives a real attestation (no test here
 * exercises finishRegistration end-to-end with real crypto; see
 * test/auth-repository-batch.test.ts's module doc, which tests the D1
 * batch atomicity in isolation instead). This lets the open-account
 * branch's own logic (total-account-cap re-check, REGISTRATION_IP_PEPPER
 * ordering, registration-event recording, isOpenRegistration flag) be
 * exercised without needing a real authenticator signature.
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

interface AccountRow {
  displayName: string;
  createdAt: string;
}

class FakeD1 {
  invites: InviteRow[] = [];
  accounts = new Map<string, AccountRow>();
  credentialAccountIds = new Map<string, string>();
  termsAcceptances: { accountId: string; termsVersion: string }[] = [];
  registrationEvents: { ipHash: string; status: string }[] = [];
  challenges = new Map<string, { id: string; metadataJson: string | null; expiresAt: string; consumedAt: string | null }>();
  sessions: { accountId: string }[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(stmts: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    const results: { meta: { changes: number } }[] = [];
    for (const stmt of stmts) {
      results.push(stmt.apply());
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

  async run(): Promise<{ meta: { changes: number } }> {
    return this.apply();
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM webauthn_credentials")) {
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
    if (this.sql.includes("SELECT COUNT(*) AS count FROM accounts")) {
      return { count: this.db.accounts.size } as unknown as T;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM sessions")) {
      return { count: 0 } as unknown as T;
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
      this.db.challenges.set(challengeHash, {
        id: challengeHash,
        metadataJson,
        expiresAt,
        consumedAt: null,
      });
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
      if (this.db.credentialAccountIds.has(credentialId)) {
        throw new Error("UNIQUE constraint failed: webauthn_credentials.credential_id");
      }
      this.db.credentialAccountIds.set(credentialId, accountId);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO account_terms_acceptances")) {
      const [, accountId, termsVersion] = this.args as [string, string, string, string];
      this.db.termsAcceptances.push({ accountId, termsVersion });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO registration_events")) {
      const [, ipHash] = this.args as [string, string, string, string];
      this.db.registrationEvents.push({ ipHash, status: "succeeded" });
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

describe("startRegistration — open (invite-less) registration", () => {
  it("issues options with userName = pendingAccountId (opaque), not the display name — duplicate display names are allowed (§7)", async () => {
    const db = new FakeD1();
    const options = await startRegistration(baseEnv(db, { REGISTRATION_MODE: "open" }), {
      open: { displayName: "Haruki", termsVersion: "2026-07-01" },
    });

    expect(options.user.displayName).toBe("Haruki");
    expect(options.user.name).not.toBe("Haruki");
    const decodedUserId = new TextDecoder().decode(base64UrlDecode(options.user.id));
    expect(options.user.name).toBe(decodedUserId);
  });

  it("rejects a blank displayName", async () => {
    const db = new FakeD1();
    await expect(
      startRegistration(baseEnv(db, { REGISTRATION_MODE: "open" }), {
        open: { displayName: "   ", termsVersion: "2026-07-01" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_DISPLAY_NAME" });
  });

  it("falls through to INVITE_REQUIRED when `open` is set but REGISTRATION_MODE is not 'open' (default 'invite')", async () => {
    const db = new FakeD1();
    await expect(
      startRegistration(baseEnv(db), { open: { displayName: "Haruki", termsVersion: "2026-07-01" } }),
    ).rejects.toMatchObject({ status: 400, code: "INVITE_REQUIRED" });
  });

  it("REGISTRATION_CLOSED still wins over an `open` param", async () => {
    const db = new FakeD1();
    await expect(
      startRegistration(baseEnv(db, { REGISTRATION_MODE: "closed" }), {
        open: { displayName: "Haruki", termsVersion: "2026-07-01" },
      }),
    ).rejects.toMatchObject({ status: 403, code: "REGISTRATION_CLOSED" });
  });
});

describe("startRegistration — invite path userName is unchanged by Phase 2 (regression guard for scope decision §7/risk 2)", () => {
  it("still passes the display name itself as userName (not an opaque id)", async () => {
    const db = new FakeD1();
    db.invites.push({
      id: "invite-1",
      token_hash: await sha256Hex("tok-123"),
      expires_at: "2999-01-01T00:00:00.000Z",
      consumed_at: null,
    });

    const options = await startRegistration(baseEnv(db), {
      invite: { inviteToken: "tok-123", displayName: "Haruki" },
    });

    expect(options.user.displayName).toBe("Haruki");
    expect(options.user.name).toBe("Haruki");
  });

  it("finishRegistration completes the invite path with no throw when TURNSTILE_SECRET_KEY / REGISTRATION_IP_PEPPER are entirely unset (品質ゲート regression: invite/closed paths must never resolve open-only secrets)", async () => {
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

    // Deliberately no MAX_TOTAL_ACCOUNTS / REGISTRATION_IP_PEPPER /
    // TURNSTILE_SECRET_KEY in this env — exactly what a production
    // REGISTRATION_MODE=invite deployment looks like.
    const result = await finishRegistration(baseEnv(db), response as never, "UA/1.0", "203.0.113.7");

    expect(result.isOpenRegistration).toBe(false);
    expect(result.session).not.toBeNull();
    expect(db.invites[0]?.consumed_at).not.toBeNull();
  });
});

describe("finishRegistration — open-account branch", () => {
  const okEnv = (db: FakeD1) =>
    baseEnv(db, { REGISTRATION_MODE: "open", MAX_TOTAL_ACCOUNTS: "500", REGISTRATION_IP_PEPPER: "ip-pepper" });

  it("creates the account, records terms acceptance + registration event, issues a session, and reports isOpenRegistration: true", async () => {
    const db = new FakeD1();
    const options = await startRegistration(okEnv(db), {
      open: { displayName: "Haruki", termsVersion: "2026-07-01" },
    });
    const response = {
      id: "cred-abc",
      rawId: "cred-abc",
      response: { clientDataJSON: await clientDataJSONFor(options.challenge) },
      clientExtensionResults: {},
      type: "public-key",
    };

    const result = await finishRegistration(okEnv(db), response as never, "UA/1.0", "203.0.113.7");

    expect(result.isOpenRegistration).toBe(true);
    expect(result.session).not.toBeNull();
    expect(db.accounts.get(result.account.id)?.displayName).toBe("Haruki");
    expect(db.termsAcceptances).toContainEqual({ accountId: result.account.id, termsVersion: "2026-07-01" });
    expect(db.registrationEvents).toHaveLength(1);
    expect(db.registrationEvents[0]?.status).toBe("succeeded");
    // ip_hash must never be the raw IP.
    expect(db.registrationEvents[0]?.ipHash).not.toBe("203.0.113.7");
    expect(db.sessions).toContainEqual({ accountId: result.account.id });
  });

  it("throws REGISTRATION_CAPACITY_REACHED (503) and creates no account when MAX_TOTAL_ACCOUNTS is already reached at verify time", async () => {
    const db = new FakeD1();
    const options = await startRegistration(okEnv(db), {
      open: { displayName: "Haruki", termsVersion: "2026-07-01" },
    });
    const response = {
      id: "cred-abc",
      rawId: "cred-abc",
      response: { clientDataJSON: await clientDataJSONFor(options.challenge) },
      clientExtensionResults: {},
      type: "public-key",
    };
    // Simulate the cap having filled up between options and verify.
    db.accounts.set("someone-else", { displayName: "Other", createdAt: "2026-01-01T00:00:00.000Z" });

    await expect(
      finishRegistration(baseEnv(db, { MAX_TOTAL_ACCOUNTS: "1", REGISTRATION_IP_PEPPER: "ip-pepper" }), response as never, "UA/1.0", "203.0.113.7"),
    ).rejects.toMatchObject({ status: 503, code: "REGISTRATION_CAPACITY_REACHED" });

    expect(db.accounts.size).toBe(1); // only "someone-else" — nothing created for this attempt
  });

  it("throws REGISTRATION_VERIFICATION_UNAVAILABLE (503, fail-closed) when REGISTRATION_IP_PEPPER is unset, and never touches the invite path's secret resolution order", async () => {
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
      finishRegistration(baseEnv(db), response as never, "UA/1.0", "203.0.113.7"),
    ).rejects.toMatchObject({ status: 503, code: "REGISTRATION_VERIFICATION_UNAVAILABLE" });

    expect(db.accounts.size).toBe(0);
  });
});
