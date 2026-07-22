// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { startRegistration } from "../src/auth/webauthn";

/**
 * 登録モード仕様 Phase1 §5.1 (closed分岐) / §5.3 (パスキー数クォータ) /
 * §5.10 のテスト。narrow FakeD1 — startRegistration が発行する SQL 形状
 * (webauthn_credentials の SELECT と auth_challenges への INSERT) のみ扱う。
 */

const ACCOUNT_ID = "acct-1";

interface CredentialRow {
  id: string;
  account_id: string;
  credential_id: string;
}

class FakeD1 {
  credentials: CredentialRow[] = [];

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

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM webauthn_credentials WHERE account_id = ?")) {
      const [accountId] = this.args as [string];
      const rows = this.db.credentials
        .filter((c) => c.account_id === accountId)
        .map((c) => ({
          id: c.id,
          account_id: c.account_id,
          credential_id: c.credential_id,
          public_key: new ArrayBuffer(0),
          sign_count: 0,
          transports_json: null,
          device_type: null,
          backed_up: 0,
          created_at: new Date().toISOString(),
          last_used_at: null,
        })) as unknown as T[];
      return { results: rows };
    }
    throw new Error(`FakeD1: unhandled all() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO auth_challenges")) {
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

function env(db: FakeD1, extra: Record<string, string> = {}) {
  return {
    APP_DB: db as unknown as D1Database,
    WEBAUTHN_RP_ID: "xtc.hr20k.com",
    ...extra,
  };
}

describe("startRegistration — passkey-count quota (existingAccount branch)", () => {
  it("rejects with 409 when already at the passkey limit", async () => {
    const db = new FakeD1();
    db.credentials.push({ id: "cred-row-1", account_id: ACCOUNT_ID, credential_id: "cred-1" });
    await expect(
      startRegistration(env(db, { MAX_PASSKEYS_PER_ACCOUNT: "1" }), {
        existingAccount: { id: ACCOUNT_ID, displayName: "Haruki" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "PASSKEY_LIMIT_EXCEEDED" });
  });

  it("allows starting registration when one slot under the limit", async () => {
    const db = new FakeD1();
    const options = await startRegistration(env(db, { MAX_PASSKEYS_PER_ACCOUNT: "1" }), {
      existingAccount: { id: ACCOUNT_ID, displayName: "Haruki" },
    });
    expect(options.rp.id).toBe("xtc.hr20k.com");
  });
});

describe("startRegistration — REGISTRATION_MODE=closed gates new-account registration", () => {
  it("rejects a new-account (invite) attempt with 403 when closed", async () => {
    const db = new FakeD1();
    await expect(
      startRegistration(env(db, { REGISTRATION_MODE: "closed" }), {
        invite: { inviteToken: "whatever", displayName: "Haruki" },
      }),
    ).rejects.toMatchObject({ status: 403, code: "REGISTRATION_CLOSED" });
  });

  it("rejects a new-account attempt with no invite at all with 403 (not INVITE_REQUIRED) when closed", async () => {
    const db = new FakeD1();
    await expect(startRegistration(env(db, { REGISTRATION_MODE: "closed" }), {})).rejects.toMatchObject({
      status: 403,
      code: "REGISTRATION_CLOSED",
    });
  });

  it("still requires an invite when closed does NOT apply and no invite/existingAccount is given (default 'invite' mode)", async () => {
    const db = new FakeD1();
    await expect(startRegistration(env(db), {})).rejects.toMatchObject({
      status: 400,
      code: "INVITE_REQUIRED",
    });
  });

  it("never gates adding a passkey to an existing (already-authenticated) account, even when closed", async () => {
    const db = new FakeD1();
    const options = await startRegistration(env(db, { REGISTRATION_MODE: "closed" }), {
      existingAccount: { id: ACCOUNT_ID, displayName: "Haruki" },
    });
    expect(options.user.name).toBe("Haruki");
  });
});

describe("startRegistration — REGISTRATION_MODE=open (Phase 1: not yet implemented, behaves like 'invite')", () => {
  // PHASE1_REVIEW.md §Nit: resolveRegistrationMode can return "open", but
  // Phase 1 has no open-registration code path — src/auth/webauthn.ts and
  // src/auth/registration-mode.ts only special-case "closed"; anything else
  // (including "open") falls through to the same invite-required behavior
  // as the default "invite" mode. This test pins that fallback down as a
  // regression guard: when Phase 2 actually implements "open", this test is
  // expected to start failing and should be updated deliberately rather
  // than the fallback silently changing shape first.
  it("still requires an invite for a new-account attempt with no invite at all (INVITE_REQUIRED, not allowed through)", async () => {
    const db = new FakeD1();
    await expect(startRegistration(env(db, { REGISTRATION_MODE: "open" }), {})).rejects.toMatchObject({
      status: 400,
      code: "INVITE_REQUIRED",
    });
  });
});
