// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  decryptOpdsConnectionField,
  encryptOpdsConnectionField,
  resolveOpdsConnectionEncryptionKey,
} from "../src/integrations/opds/connection-crypto";

function makeKey(byte: number, length = 32): string {
  const bytes = new Uint8Array(length).fill(byte);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const VALID_KEY = makeKey(3);
const ENV = { OPDS_CONNECTION_ENCRYPTION_KEY: VALID_KEY };
const CTX = { accountId: "acct-1", connectionId: "conn-1", field: "catalog_url" as const };

describe("resolveOpdsConnectionEncryptionKey", () => {
  it("imports a valid base64 32-byte key", async () => {
    await expect(resolveOpdsConnectionEncryptionKey(ENV)).resolves.toBeDefined();
  });

  it("throws when unset", async () => {
    await expect(resolveOpdsConnectionEncryptionKey({ OPDS_CONNECTION_ENCRYPTION_KEY: undefined })).rejects.toThrow();
  });

  it("throws when not valid base64", async () => {
    await expect(
      resolveOpdsConnectionEncryptionKey({ OPDS_CONNECTION_ENCRYPTION_KEY: "!!not-base64!!" }),
    ).rejects.toThrow();
  });

  it("throws when the decoded key isn't 32 bytes", async () => {
    await expect(
      resolveOpdsConnectionEncryptionKey({ OPDS_CONNECTION_ENCRYPTION_KEY: makeKey(1, 16) }),
    ).rejects.toThrow();
  });
});

describe("encryptOpdsConnectionField / decryptOpdsConnectionField", () => {
  it("round-trips plaintext", async () => {
    const encrypted = await encryptOpdsConnectionField(ENV, CTX, "https://opds.example.com/secret/catalog");
    await expect(decryptOpdsConnectionField(ENV, CTX, encrypted)).resolves.toBe(
      "https://opds.example.com/secret/catalog",
    );
  });

  it("produces a different IV on every call", async () => {
    const a = await encryptOpdsConnectionField(ENV, CTX, "url");
    const b = await encryptOpdsConnectionField(ENV, CTX, "url");
    expect(a.iv).not.toEqual(b.iv);
  });

  it("fails to decrypt a tampered ciphertext", async () => {
    const encrypted = await encryptOpdsConnectionField(ENV, CTX, "url-value");
    const tampered = new Uint8Array(encrypted.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    await expect(decryptOpdsConnectionField(ENV, CTX, { ...encrypted, ciphertext: tampered })).rejects.toThrow();
  });

  it("fails to decrypt with the wrong key", async () => {
    const encrypted = await encryptOpdsConnectionField(ENV, CTX, "url-value");
    await expect(
      decryptOpdsConnectionField({ OPDS_CONNECTION_ENCRYPTION_KEY: makeKey(9) }, CTX, encrypted),
    ).rejects.toThrow();
  });

  it("fails to decrypt when accountId doesn't match (AAD mismatch)", async () => {
    const encrypted = await encryptOpdsConnectionField(ENV, CTX, "url-value");
    await expect(
      decryptOpdsConnectionField(ENV, { ...CTX, accountId: "acct-2" }, encrypted),
    ).rejects.toThrow();
  });

  it("fails to decrypt when connectionId doesn't match (AAD mismatch)", async () => {
    const encrypted = await encryptOpdsConnectionField(ENV, CTX, "url-value");
    await expect(
      decryptOpdsConnectionField(ENV, { ...CTX, connectionId: "conn-2" }, encrypted),
    ).rejects.toThrow();
  });

  it("fails to decrypt when field doesn't match (AAD mismatch) — ciphertext for one field can't be reused as another", async () => {
    const encrypted = await encryptOpdsConnectionField(ENV, CTX, "url-value");
    await expect(
      decryptOpdsConnectionField(ENV, { ...CTX, field: "username" }, encrypted),
    ).rejects.toThrow();
  });
});
