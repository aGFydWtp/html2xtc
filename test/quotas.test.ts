// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  resolveMaxActiveSessionsPerAccount,
  resolveMaxDevicesPerAccount,
  resolveMaxLibraryBytesPerAccount,
  resolveMaxLibraryItemsPerAccount,
  resolveMaxPasskeysPerAccount,
} from "../src/quotas";

describe("quota resolvers", () => {
  it("default to the documented values when unset", () => {
    expect(resolveMaxLibraryItemsPerAccount({})).toBe(100);
    expect(resolveMaxLibraryBytesPerAccount({})).toBe(1_073_741_824);
    expect(resolveMaxDevicesPerAccount({})).toBe(5);
    expect(resolveMaxActiveSessionsPerAccount({})).toBe(10);
    expect(resolveMaxPasskeysPerAccount({})).toBe(5);
  });

  it("honor a positive override", () => {
    expect(resolveMaxLibraryItemsPerAccount({ MAX_LIBRARY_ITEMS_PER_ACCOUNT: "250" })).toBe(250);
    expect(resolveMaxLibraryBytesPerAccount({ MAX_LIBRARY_BYTES_PER_ACCOUNT: "2048" })).toBe(2048);
    expect(resolveMaxDevicesPerAccount({ MAX_DEVICES_PER_ACCOUNT: "9" })).toBe(9);
    expect(resolveMaxActiveSessionsPerAccount({ MAX_ACTIVE_SESSIONS_PER_ACCOUNT: "3" })).toBe(3);
    expect(resolveMaxPasskeysPerAccount({ MAX_PASSKEYS_PER_ACCOUNT: "1" })).toBe(1);
  });

  it("fall back to the default on garbage or non-positive values (never disable the quota)", () => {
    expect(resolveMaxLibraryItemsPerAccount({ MAX_LIBRARY_ITEMS_PER_ACCOUNT: "banana" })).toBe(100);
    expect(resolveMaxLibraryItemsPerAccount({ MAX_LIBRARY_ITEMS_PER_ACCOUNT: "0" })).toBe(100);
    expect(resolveMaxLibraryItemsPerAccount({ MAX_LIBRARY_ITEMS_PER_ACCOUNT: "-5" })).toBe(100);
    expect(resolveMaxDevicesPerAccount({ MAX_DEVICES_PER_ACCOUNT: "" })).toBe(5);
  });
});
