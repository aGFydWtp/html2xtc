// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import type { Account } from "../src/auth/sessions";
import { createManualOpdsDevice, resolveManualDeviceProfile } from "../src/devices/service";

/**
 * Phase2 spec §8.1 / §13.1 "手動端末作成". FakeD1 models exactly what
 * createManualOpdsDevice touches: the devices-count quota SELECT and the
 * INSERT INTO devices — same narrow-fake convention as
 * test/devices-pairings-quota.test.ts.
 */

const ACCOUNT: Account = { id: "acct-1", displayName: "Haruki" };

interface DeviceRow {
  id: string;
  account_id: string;
  name: string;
  token_hash: string;
  status: string;
  device: string | null;
  width: number | null;
  height: number | null;
  registration_method: string;
}

class FakeD1 {
  devices: DeviceRow[] = [];

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
      const [accountId] = this.args as [string];
      const count = this.db.devices.filter((d) => d.account_id === accountId && d.status === "active").length;
      return { count } as T;
    }
    throw new Error(`FakeD1: unhandled first() query: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO devices")) {
      const [id, accountId, name, tokenHash, , , device, width, height, registrationMethod] = this.args as [
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        number | null,
        number | null,
        string,
      ];
      this.db.devices.push({
        id,
        account_id: accountId,
        name,
        token_hash: tokenHash,
        status: "active",
        device,
        width,
        height,
        registration_method: registrationMethod,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() query: ${this.sql}`);
  }
}

function makeEnv(db: FakeD1, maxDevices = "5") {
  return { APP_DB: db as unknown as D1Database, MAX_DEVICES_PER_ACCOUNT: maxDevices };
}

describe("resolveManualDeviceProfile", () => {
  it("normalizes x3 to the DEVICE_PROFILES preset, ignoring client width/height", () => {
    expect(resolveManualDeviceProfile("x3", 999, 999)).toEqual({ device: "x3", width: 528, height: 792 });
  });

  it("normalizes x4 to the DEVICE_PROFILES preset, ignoring client width/height", () => {
    expect(resolveManualDeviceProfile("x4", undefined, undefined)).toEqual({
      device: "x4",
      width: 480,
      height: 800,
    });
  });

  it("accepts 'other' with both width and height given", () => {
    expect(resolveManualDeviceProfile("other", 600, 800)).toEqual({ device: null, width: 600, height: 800 });
  });

  it("accepts an omitted deviceModel with both dimensions omitted (unknown resolution)", () => {
    expect(resolveManualDeviceProfile(undefined, undefined, undefined)).toEqual({
      device: null,
      width: null,
      height: null,
    });
    expect(resolveManualDeviceProfile(null, null, null)).toEqual({ device: null, width: null, height: null });
  });

  it("rejects an unrecognized deviceModel", () => {
    expect(() => resolveManualDeviceProfile("x5", undefined, undefined)).toThrow(
      expect.objectContaining({ status: 400, code: "INVALID_DEVICE_MODEL" }),
    );
  });

  it("rejects only one of width/height given", () => {
    expect(() => resolveManualDeviceProfile("other", 600, undefined)).toThrow(
      expect.objectContaining({ status: 400, code: "INVALID_DEVICE_RESOLUTION" }),
    );
    expect(() => resolveManualDeviceProfile(null, undefined, 800)).toThrow(
      expect.objectContaining({ status: 400, code: "INVALID_DEVICE_RESOLUTION" }),
    );
  });

  it("rejects a non-integer, zero, negative, or too-large dimension", () => {
    for (const bad of [0, -1, 1.5, 10_001, "600"]) {
      expect(() => resolveManualDeviceProfile("other", bad, 800)).toThrow(
        expect.objectContaining({ status: 400, code: "INVALID_DEVICE_RESOLUTION" }),
      );
    }
  });
});

describe("createManualOpdsDevice", () => {
  it("returns 201-shaped result: active, manual_opds, a token, and matching DTO fields", async () => {
    const db = new FakeD1();
    const result = await createManualOpdsDevice(makeEnv(db), ACCOUNT, {
      name: "Xteink X3",
      deviceModel: "x3",
      width: undefined,
      height: undefined,
    });

    expect(result.device.status).toBe("active");
    expect(result.device.registrationMethod).toBe("manual_opds");
    expect(result.device.device).toBe("x3");
    expect(result.device.width).toBe(528);
    expect(result.device.height).toBe(792);
    expect(result.device.lastSeenAt).toBeNull();
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(0);
  });

  it("stores only the token hash in D1, never the plaintext token", async () => {
    const db = new FakeD1();
    const result = await createManualOpdsDevice(makeEnv(db), ACCOUNT, {
      name: "Xteink X4",
      deviceModel: "x4",
      width: undefined,
      height: undefined,
    });

    expect(db.devices).toHaveLength(1);
    const stored = db.devices[0]!;
    expect(stored.token_hash).not.toBe(result.token);
    expect(JSON.stringify(db.devices)).not.toContain(result.token);
  });

  it("persists registration_method='manual_opds'", async () => {
    const db = new FakeD1();
    await createManualOpdsDevice(makeEnv(db), ACCOUNT, {
      name: "Other Reader",
      deviceModel: "other",
      width: 600,
      height: 800,
    });
    expect(db.devices[0]!.registration_method).toBe("manual_opds");
    expect(db.devices[0]!.width).toBe(600);
    expect(db.devices[0]!.height).toBe(800);
  });

  it("rejects a missing/blank name with 400 INVALID_DEVICE_NAME", async () => {
    const db = new FakeD1();
    await expect(
      createManualOpdsDevice(makeEnv(db), ACCOUNT, { name: "   ", deviceModel: null, width: undefined, height: undefined }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_DEVICE_NAME" });
    expect(db.devices).toHaveLength(0);
  });

  it("rejects an invalid deviceModel with 400 INVALID_DEVICE_MODEL", async () => {
    const db = new FakeD1();
    await expect(
      createManualOpdsDevice(makeEnv(db), ACCOUNT, { name: "Reader", deviceModel: "not-a-model", width: undefined, height: undefined }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_DEVICE_MODEL" });
    expect(db.devices).toHaveLength(0);
  });

  it("rejects an invalid resolution with 400 INVALID_DEVICE_RESOLUTION", async () => {
    const db = new FakeD1();
    await expect(
      createManualOpdsDevice(makeEnv(db), ACCOUNT, { name: "Reader", deviceModel: "other", width: -5, height: 800 }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_DEVICE_RESOLUTION" });
    expect(db.devices).toHaveLength(0);
  });

  it("rejects with 409 DEVICE_LIMIT_EXCEEDED when the account is already at the device quota, without inserting a row", async () => {
    const db = new FakeD1();
    db.devices.push({
      id: "dev-existing",
      account_id: ACCOUNT.id,
      name: "Existing",
      token_hash: "hash",
      status: "active",
      device: null,
      width: null,
      height: null,
      registration_method: "pairing",
    });

    await expect(
      createManualOpdsDevice(makeEnv(db, "1"), ACCOUNT, {
        name: "New Reader",
        deviceModel: null,
        width: undefined,
        height: undefined,
      }),
    ).rejects.toMatchObject({ status: 409, code: "DEVICE_LIMIT_EXCEEDED" });
    expect(db.devices).toHaveLength(1);
  });
});
