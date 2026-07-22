// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  resolveMaxActiveSessionsPerAccount,
  resolveMaxDevicesPerAccount,
  resolveMaxLibraryBytesPerAccount,
  resolveMaxLibraryItemsPerAccount,
  resolveMaxNewAccountsPerDay,
  resolveMaxNewAccountsPerIpPerDay,
  resolveMaxPasskeysPerAccount,
  resolveMaxTotalAccounts,
  resolveMaxTotalLibraryBytes,
  resolveTermsVersion,
  resolveTotalStorageStopPercent,
  resolveTotalStorageWarningPercent,
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

describe("登録モード仕様 Phase 2: service-wide quota resolvers", () => {
  it("default to the documented values when unset", () => {
    expect(resolveMaxTotalAccounts({})).toBe(500);
    expect(resolveMaxNewAccountsPerDay({})).toBe(50);
    expect(resolveMaxNewAccountsPerIpPerDay({})).toBe(3);
    expect(resolveMaxTotalLibraryBytes({})).toBe(53_687_091_200);
    expect(resolveTotalStorageWarningPercent({})).toBe(80);
    expect(resolveTotalStorageStopPercent({})).toBe(95);
  });

  it("honor a positive override", () => {
    expect(resolveMaxTotalAccounts({ MAX_TOTAL_ACCOUNTS: "1000" })).toBe(1000);
    expect(resolveMaxNewAccountsPerDay({ MAX_NEW_ACCOUNTS_PER_DAY: "10" })).toBe(10);
    expect(resolveMaxNewAccountsPerIpPerDay({ MAX_NEW_ACCOUNTS_PER_IP_PER_DAY: "1" })).toBe(1);
    expect(resolveMaxTotalLibraryBytes({ MAX_TOTAL_LIBRARY_BYTES: "2048" })).toBe(2048);
  });

  it("fall back to the default on garbage or non-positive values (never disable the quota)", () => {
    expect(resolveMaxTotalAccounts({ MAX_TOTAL_ACCOUNTS: "0" })).toBe(500);
    expect(resolveMaxTotalAccounts({ MAX_TOTAL_ACCOUNTS: "-1" })).toBe(500);
    expect(resolveMaxTotalAccounts({ MAX_TOTAL_ACCOUNTS: "banana" })).toBe(500);
  });

  it("percent resolvers accept 0 as a real configured value, and clamp out-of-range values to the default", () => {
    expect(resolveTotalStorageWarningPercent({ TOTAL_STORAGE_WARNING_PERCENT: "0" })).toBe(0);
    expect(resolveTotalStorageWarningPercent({ TOTAL_STORAGE_WARNING_PERCENT: "100" })).toBe(100);
    expect(resolveTotalStorageWarningPercent({ TOTAL_STORAGE_WARNING_PERCENT: "101" })).toBe(80);
    expect(resolveTotalStorageWarningPercent({ TOTAL_STORAGE_WARNING_PERCENT: "-1" })).toBe(80);
    expect(resolveTotalStorageWarningPercent({ TOTAL_STORAGE_WARNING_PERCENT: "banana" })).toBe(80);
    expect(resolveTotalStorageStopPercent({ TOTAL_STORAGE_STOP_PERCENT: "50" })).toBe(50);
  });
});

describe("resolveTermsVersion", () => {
  it("returns null when unset — fail-safe, not a fabricated fallback value", () => {
    expect(resolveTermsVersion({})).toBeNull();
    expect(resolveTermsVersion({ TERMS_VERSION: "" })).toBeNull();
  });

  it("returns the configured value verbatim", () => {
    expect(resolveTermsVersion({ TERMS_VERSION: "2026-07-01" })).toBe("2026-07-01");
  });
});
