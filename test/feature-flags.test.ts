// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { resolveConversionMode, resolveLibraryWriteMode, resolvePairingMode } from "../src/feature-flags";

/**
 * 登録モード仕様 Phase3 §7: 機能フラグ3種の resolver。「未設定・不正値は
 * 常に許可側」という resolveRegistrationMode と同じフォールバック方針を
 * 各flagについて固定するリグレッションガード
 * (PHASE3_GAP_ANALYSIS.md §6 risk 2)。
 */

describe("resolveLibraryWriteMode", () => {
  it("defaults to read-write when unset", () => {
    expect(resolveLibraryWriteMode({})).toBe("read-write");
  });

  it("falls back to read-write on garbage values", () => {
    expect(resolveLibraryWriteMode({ LIBRARY_WRITE_MODE: "banana" })).toBe("read-write");
    expect(resolveLibraryWriteMode({ LIBRARY_WRITE_MODE: "" })).toBe("read-write");
    expect(resolveLibraryWriteMode({ LIBRARY_WRITE_MODE: "READ-ONLY" })).toBe("read-write");
  });

  it("resolves read-only only on the exact value", () => {
    expect(resolveLibraryWriteMode({ LIBRARY_WRITE_MODE: "read-only" })).toBe("read-only");
  });

  it("resolves read-write explicitly", () => {
    expect(resolveLibraryWriteMode({ LIBRARY_WRITE_MODE: "read-write" })).toBe("read-write");
  });
});

describe("resolvePairingMode", () => {
  it("defaults to enabled when unset", () => {
    expect(resolvePairingMode({})).toBe("enabled");
  });

  it("falls back to enabled on garbage values", () => {
    expect(resolvePairingMode({ PAIRING_MODE: "banana" })).toBe("enabled");
    expect(resolvePairingMode({ PAIRING_MODE: "" })).toBe("enabled");
    expect(resolvePairingMode({ PAIRING_MODE: "DISABLED" })).toBe("enabled");
  });

  it("resolves disabled only on the exact value", () => {
    expect(resolvePairingMode({ PAIRING_MODE: "disabled" })).toBe("disabled");
  });

  it("resolves enabled explicitly", () => {
    expect(resolvePairingMode({ PAIRING_MODE: "enabled" })).toBe("enabled");
  });
});

describe("resolveConversionMode", () => {
  it("defaults to enabled when unset", () => {
    expect(resolveConversionMode({})).toBe("enabled");
  });

  it("falls back to enabled on garbage values", () => {
    expect(resolveConversionMode({ CONVERSION_MODE: "banana" })).toBe("enabled");
    expect(resolveConversionMode({ CONVERSION_MODE: "" })).toBe("enabled");
    expect(resolveConversionMode({ CONVERSION_MODE: "DISABLED" })).toBe("enabled");
  });

  it("resolves disabled only on the exact value", () => {
    expect(resolveConversionMode({ CONVERSION_MODE: "disabled" })).toBe("disabled");
  });

  it("resolves enabled explicitly", () => {
    expect(resolveConversionMode({ CONVERSION_MODE: "enabled" })).toBe("enabled");
  });
});
