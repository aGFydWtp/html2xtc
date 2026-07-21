// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import type { Account } from "../src/auth/sessions";
import { replaceDeviceLibrary } from "../src/devices/service";
import { ApiError } from "../src/security/errors";

/**
 * Review finding L5 / task item 8: PUT /api/devices/:deviceId/library only
 * checked ownership (requireOwnedDevice), not device status — so a revoked
 * device's delivery list could still be edited even though the device can
 * never authenticate to fetch it again. replaceDeviceLibrary now rejects
 * with 409 DEVICE_REVOKED before doing anything else once the device isn't
 * 'active'.
 *
 * FakeD1 only implements the one SELECT requireOwnedDevice issues
 * (getDeviceById) — every other table access throws if reached, which is
 * exactly how these tests prove the revoked check short-circuits before any
 * version check, ownership count, or device_library_items write.
 */
class FakeD1 {
  constructor(private readonly device: Record<string, unknown> | null) {}

  prepare(sql: string): FakeStatement {
    if (sql.includes("SELECT") && sql.includes("FROM devices WHERE id = ? AND account_id = ?")) {
      return new FakeStatement(this.device);
    }
    throw new Error(`FakeD1: unexpected query reached past the revoked-device check: ${sql}`);
  }
}

class FakeStatement {
  constructor(private readonly device: Record<string, unknown> | null) {}
  bind(): FakeStatement {
    return this;
  }
  async first<T>(): Promise<T | null> {
    return this.device as T | null;
  }
}

const ACCOUNT: Account = { id: "acct-1", displayName: "Haruki" };

function deviceRow(status: string) {
  return {
    id: "dev-1",
    account_id: "acct-1",
    name: "Reader",
    status,
    library_version: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: null,
    revoked_at: status === "revoked" ? "2026-01-02T00:00:00.000Z" : null,
  };
}

describe("replaceDeviceLibrary — revoked-device rejection", () => {
  it("rejects with 409 DEVICE_REVOKED for a revoked device, before touching device_library_items", async () => {
    const env = { APP_DB: new FakeD1(deviceRow("revoked")) as unknown as D1Database };

    await expect(
      replaceDeviceLibrary(env, ACCOUNT, "dev-1", { expectedVersion: 3, itemIds: [] }),
    ).rejects.toMatchObject({ status: 409, code: "DEVICE_REVOKED" } satisfies Partial<ApiError>);
  });

  it("throws DEVICE_NOT_FOUND (not DEVICE_REVOKED) when the device doesn't exist/isn't owned", async () => {
    const env = { APP_DB: new FakeD1(null) as unknown as D1Database };

    await expect(
      replaceDeviceLibrary(env, ACCOUNT, "dev-missing", { expectedVersion: 1, itemIds: [] }),
    ).rejects.toMatchObject({ status: 404, code: "DEVICE_NOT_FOUND" } satisfies Partial<ApiError>);
  });
});
