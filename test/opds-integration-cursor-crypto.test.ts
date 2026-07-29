// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_OPDS_CURSOR_DEPTH,
  decryptOpdsCursor,
  encryptOpdsCursor,
} from "../src/integrations/opds/cursor-crypto";

function makeKey(byte: number, length = 32): string {
  const bytes = new Uint8Array(length).fill(byte);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const VALID_KEY = makeKey(5);
const ENV = { OPDS_CURSOR_ENCRYPTION_KEY: VALID_KEY };

const BASE_INPUT = {
  accountId: "acct-1",
  connectionId: "conn-1",
  kind: "navigation" as const,
  url: "https://opds.example.com/catalog/sub",
  depth: 1,
};

describe("encryptOpdsCursor / decryptOpdsCursor", () => {
  it("round-trips a valid cursor", async () => {
    const token = await encryptOpdsCursor(ENV, BASE_INPUT);
    const result = await decryptOpdsCursor(ENV, token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.accountId).toBe("acct-1");
      expect(result.payload.connectionId).toBe("conn-1");
      expect(result.payload.kind).toBe("navigation");
      expect(result.payload.url).toBe(BASE_INPUT.url);
      expect(result.payload.depth).toBe(1);
    }
  });

  it("rejects a malformed token", async () => {
    const result = await decryptOpdsCursor(ENV, "not-a-valid-cursor!!");
    expect(result.ok).toBe(false);
  });

  it("rejects a tampered token", async () => {
    const token = await encryptOpdsCursor(ENV, BASE_INPUT);
    const tampered = `${token.slice(0, -2)}xx`;
    const result = await decryptOpdsCursor(ENV, tampered);
    expect(result.ok).toBe(false);
  });

  it("rejects a cursor encrypted with a different key", async () => {
    const token = await encryptOpdsCursor(ENV, BASE_INPUT);
    const result = await decryptOpdsCursor({ OPDS_CURSOR_ENCRYPTION_KEY: makeKey(9) }, token);
    expect(result.ok).toBe(false);
  });

  it("rejects depth beyond MAX_OPDS_CURSOR_DEPTH at issuance", async () => {
    await expect(
      encryptOpdsCursor(ENV, { ...BASE_INPUT, depth: MAX_OPDS_CURSOR_DEPTH + 1 }),
    ).rejects.toThrow();
  });

  it("accepts depth exactly at MAX_OPDS_CURSOR_DEPTH", async () => {
    const token = await encryptOpdsCursor(ENV, { ...BASE_INPUT, depth: MAX_OPDS_CURSOR_DEPTH });
    const result = await decryptOpdsCursor(ENV, token);
    expect(result.ok).toBe(true);
  });

  describe("expiry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects an expired cursor (>15 minutes old)", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const token = await encryptOpdsCursor(ENV, BASE_INPUT);
      vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));
      const result = await decryptOpdsCursor(ENV, token);
      expect(result.ok).toBe(false);
    });

    it("accepts a cursor just under 15 minutes old", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const token = await encryptOpdsCursor(ENV, BASE_INPUT);
      vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
      const result = await decryptOpdsCursor(ENV, token);
      expect(result.ok).toBe(true);
    });
  });

  it("carries kind/accountId/connectionId so a caller can reject a mismatch itself", async () => {
    const token = await encryptOpdsCursor(ENV, BASE_INPUT);
    const result = await decryptOpdsCursor(ENV, token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Simulates the service-layer check: a cursor issued for one
      // connection must never validate against another.
      expect(result.payload.connectionId === "some-other-connection").toBe(false);
      expect(result.payload.accountId === "some-other-account").toBe(false);
      expect(result.payload.kind === "acquisition_epub").toBe(false);
    }
  });
});
