// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { opaqueOpdsEntryId } from "../src/integrations/opds/entry-id";

function makeKey(byte: number): string {
  const bytes = new Uint8Array(32).fill(byte);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe("opaqueOpdsEntryId", () => {
  it("is deterministic for the same connectionId/sourceId", async () => {
    const env = { OPDS_CURSOR_ENCRYPTION_KEY: makeKey(1) };
    const a = await opaqueOpdsEntryId(env, "conn-1", "urn:uuid:1111");
    const b = await opaqueOpdsEntryId(env, "conn-1", "urn:uuid:1111");
    expect(a).toBe(b);
  });

  it("returns 24 lowercase hex characters (96 bits)", async () => {
    const env = { OPDS_CURSOR_ENCRYPTION_KEY: makeKey(1) };
    const id = await opaqueOpdsEntryId(env, "conn-1", "urn:uuid:1111");
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("differs per connectionId for the same sourceId (no cross-connection correlation)", async () => {
    const env = { OPDS_CURSOR_ENCRYPTION_KEY: makeKey(1) };
    const a = await opaqueOpdsEntryId(env, "conn-1", "urn:uuid:1111");
    const b = await opaqueOpdsEntryId(env, "conn-2", "urn:uuid:1111");
    expect(a).not.toBe(b);
  });

  it("differs per key (HMAC keyed by OPDS_CURSOR_ENCRYPTION_KEY, not just a public hash)", async () => {
    const a = await opaqueOpdsEntryId({ OPDS_CURSOR_ENCRYPTION_KEY: makeKey(1) }, "conn-1", "urn:uuid:1111");
    const b = await opaqueOpdsEntryId({ OPDS_CURSOR_ENCRYPTION_KEY: makeKey(2) }, "conn-1", "urn:uuid:1111");
    expect(a).not.toBe(b);
  });

  it("never reveals the source id in the output", async () => {
    const env = { OPDS_CURSOR_ENCRYPTION_KEY: makeKey(1) };
    const id = await opaqueOpdsEntryId(env, "conn-1", "https://opds.example.com/secret/xyz789");
    expect(id).not.toContain("secret");
    expect(id).not.toContain("xyz789");
  });

  it("throws when OPDS_CURSOR_ENCRYPTION_KEY is not configured", async () => {
    await expect(opaqueOpdsEntryId({ OPDS_CURSOR_ENCRYPTION_KEY: undefined }, "conn-1", "id-1")).rejects.toThrow();
  });
});
