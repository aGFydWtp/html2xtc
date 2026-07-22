// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { approvePairingForAccount } from "../src/devices/pairings";

/**
 * 登録モード仕様 Phase1 §5.3 / §5.10: デバイス数クォータの境界値テスト。
 * FakeD1 は approvePairingForAccount が発行する SQL 形状だけを扱う narrow
 * fake（test/auth-repository-batch.test.ts と同じ方針）。PAIRING_ENCRYPTION_KEY
 * は src/security/aes-gcm.ts の実装に渡す必要があるため、32バイトの
 * base64url キーを用意する。
 */

const ACCOUNT_ID = "acct-1";
const PAIRING_ID = "pairing-1";

function pairingEncryptionKey(): string {
  // 32 raw bytes, base64url — matches resolvePairingEncryptionKey's expected shape.
  const bytes = new Uint8Array(32).fill(7);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface DeviceRow {
  id: string;
  account_id: string;
  status: string;
}

class FakeD1 {
  devices: DeviceRow[] = [];
  pairingApproved = false;

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
    if (this.sql.includes("FROM device_pairings")) {
      // Always a still-pending, unexpired pairing for this test's purposes.
      return {
        id: PAIRING_ID,
        user_code: "ABCD-2345",
        pairing_secret_hash: "unused",
        requested_name: null,
        status: "pending",
        account_id: null,
        device_id: null,
        encrypted_device_token: null,
        token_iv: null,
        token_auth_tag: null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        approved_at: null,
        completed_at: null,
      } as T;
    }
    if (this.sql.includes("COUNT(*) AS count")) {
      const [accountId] = this.args as [string];
      const count = this.db.devices.filter((d) => d.account_id === accountId && d.status === "active").length;
      return { count } as T;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO devices")) {
      const [id, accountId] = this.args as [string, string];
      this.db.devices.push({ id, account_id: accountId, status: "active" });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE device_pairings")) {
      this.db.pairingApproved = true;
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("DELETE FROM devices")) {
      const [id] = this.args as [string];
      this.db.devices = this.db.devices.filter((d) => d.id !== id);
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

describe("approvePairingForAccount — device-count quota", () => {
  it("rejects with 409 and never creates a device row when already at the limit", async () => {
    const db = new FakeD1();
    db.devices.push({ id: "dev-1", account_id: ACCOUNT_ID, status: "active" });
    const env = {
      APP_DB: db as unknown as D1Database,
      PAIRING_ENCRYPTION_KEY: pairingEncryptionKey(),
      MAX_DEVICES_PER_ACCOUNT: "1",
    };

    await expect(
      approvePairingForAccount(env, { id: ACCOUNT_ID, displayName: "Haruki" }, PAIRING_ID, "New Device"),
    ).rejects.toMatchObject({ status: 409, code: "DEVICE_LIMIT_EXCEEDED" });

    expect(db.devices).toHaveLength(1);
    expect(db.pairingApproved).toBe(false);
  });

  it("allows approval when one slot under the limit", async () => {
    const db = new FakeD1();
    const env = {
      APP_DB: db as unknown as D1Database,
      PAIRING_ENCRYPTION_KEY: pairingEncryptionKey(),
      MAX_DEVICES_PER_ACCOUNT: "1",
    };

    const device = await approvePairingForAccount(
      env,
      { id: ACCOUNT_ID, displayName: "Haruki" },
      PAIRING_ID,
      "New Device",
    );
    expect(device.name).toBe("New Device");
    expect(db.devices).toHaveLength(1);
    expect(db.pairingApproved).toBe(true);
  });
});
