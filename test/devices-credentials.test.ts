// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  generateDeviceToken,
  hashDeviceToken,
  issueDeviceCredential,
  verifyDeviceToken,
} from "../src/devices/credentials";
import { sha256Hex } from "../src/security/crypto";

/**
 * Phase2 spec §9 "token 生成とハッシュ化を...共通モジュールへ抽出する": these
 * are the primitives both approvePairingForAccount (src/devices/pairings.ts)
 * and the manual-OPDS create/rotate flows (src/devices/service.ts) now share.
 */

describe("generateDeviceToken", () => {
  it("produces a base64url string with no padding", () => {
    const token = generateDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
  });

  it("decodes to 32 raw bytes (256 bits)", () => {
    const token = generateDeviceToken();
    const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bytes = atob(padded);
    expect(bytes.length).toBe(32);
  });

  it("produces different tokens across calls", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateDeviceToken()));
    expect(tokens.size).toBe(20);
  });
});

describe("hashDeviceToken", () => {
  it("matches sha256Hex(token) directly (no pepper)", async () => {
    const token = "some-plaintext-token";
    expect(await hashDeviceToken(token)).toBe(await sha256Hex(token));
  });

  it("is deterministic for the same input", async () => {
    const token = "fixed-token-value";
    expect(await hashDeviceToken(token)).toBe(await hashDeviceToken(token));
  });
});

describe("verifyDeviceToken", () => {
  it("returns true when the token hashes to the stored hash", async () => {
    const token = generateDeviceToken();
    const tokenHash = await hashDeviceToken(token);
    expect(await verifyDeviceToken(token, tokenHash)).toBe(true);
  });

  it("returns false for a wrong token", async () => {
    const tokenHash = await hashDeviceToken(generateDeviceToken());
    expect(await verifyDeviceToken("wrong-token", tokenHash)).toBe(false);
  });

  it("returns false for a hash of different length", async () => {
    expect(await verifyDeviceToken("token", "not-a-real-hash")).toBe(false);
  });
});

describe("issueDeviceCredential", () => {
  it("returns a token whose hash matches the returned tokenHash", async () => {
    const { token, tokenHash } = await issueDeviceCredential();
    expect(await hashDeviceToken(token)).toBe(tokenHash);
    expect(await verifyDeviceToken(token, tokenHash)).toBe(true);
  });

  it("produces distinct credentials across calls", async () => {
    const a = await issueDeviceCredential();
    const b = await issueDeviceCredential();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
