import { describe, expect, it } from "vitest";
import {
  decryptWithPairingKey,
  encryptWithPairingKey,
  resolvePairingEncryptionKey,
} from "../src/security/aes-gcm";

function makeKey(byte: number, length = 32): string {
  const bytes = new Uint8Array(length).fill(byte);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

const VALID_KEY = makeKey(7);

describe("resolvePairingEncryptionKey", () => {
  it("imports a valid base64 32-byte key", async () => {
    await expect(resolvePairingEncryptionKey({ PAIRING_ENCRYPTION_KEY: VALID_KEY })).resolves.toBeDefined();
  });

  it("throws when unset", async () => {
    await expect(
      resolvePairingEncryptionKey({ PAIRING_ENCRYPTION_KEY: undefined }),
    ).rejects.toThrow();
  });

  it("throws when empty", async () => {
    await expect(resolvePairingEncryptionKey({ PAIRING_ENCRYPTION_KEY: "" })).rejects.toThrow();
  });

  it("throws when not valid base64", async () => {
    await expect(
      resolvePairingEncryptionKey({ PAIRING_ENCRYPTION_KEY: "not-valid-base64!!" }),
    ).rejects.toThrow();
  });

  it("throws when the decoded key isn't 32 bytes", async () => {
    await expect(
      resolvePairingEncryptionKey({ PAIRING_ENCRYPTION_KEY: makeKey(1, 16) }),
    ).rejects.toThrow();
  });
});

describe("encryptWithPairingKey / decryptWithPairingKey", () => {
  it("round-trips plaintext", async () => {
    const env = { PAIRING_ENCRYPTION_KEY: VALID_KEY };
    const payload = await encryptWithPairingKey(env, "super-secret-device-token");
    await expect(decryptWithPairingKey(env, payload)).resolves.toBe("super-secret-device-token");
  });

  it("produces a different IV on every call", async () => {
    const env = { PAIRING_ENCRYPTION_KEY: VALID_KEY };
    const a = await encryptWithPairingKey(env, "token");
    const b = await encryptWithPairingKey(env, "token");
    expect(a.iv).not.toEqual(b.iv);
  });

  it("fails to decrypt a tampered ciphertext", async () => {
    const env = { PAIRING_ENCRYPTION_KEY: VALID_KEY };
    const payload = await encryptWithPairingKey(env, "token-value");
    const tampered = new Uint8Array(payload.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    await expect(
      decryptWithPairingKey(env, { ...payload, ciphertext: tampered }),
    ).rejects.toThrow();
  });

  it("fails to decrypt with a tampered auth tag", async () => {
    const env = { PAIRING_ENCRYPTION_KEY: VALID_KEY };
    const payload = await encryptWithPairingKey(env, "token-value");
    const tampered = new Uint8Array(payload.authTag);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    await expect(
      decryptWithPairingKey(env, { ...payload, authTag: tampered }),
    ).rejects.toThrow();
  });

  it("fails to decrypt with the wrong key", async () => {
    const payload = await encryptWithPairingKey({ PAIRING_ENCRYPTION_KEY: VALID_KEY }, "token-value");
    await expect(
      decryptWithPairingKey({ PAIRING_ENCRYPTION_KEY: makeKey(9) }, payload),
    ).rejects.toThrow();
  });
});
