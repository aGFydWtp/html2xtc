import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from "../src/security/crypto";

describe("randomToken", () => {
  it("defaults to 32 bytes, base64url-encoded (no padding, URL-safe alphabet)", () => {
    const token = randomToken();
    expect(token).not.toMatch(/[+/=]/);
    // 32 bytes -> ceil(32*8/6) = 43 base64url characters, no padding.
    expect(token.length).toBe(43);
  });

  it("honors a custom byte length", () => {
    expect(randomToken(16).length).toBe(22);
  });

  it("is different on every call (extremely unlikely to collide)", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
  });
});

describe("base64UrlEncode / base64UrlDecode", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 16, 32, 64, 128]);
    const encoded = base64UrlEncode(bytes);
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });

  it("never emits standard-base64 characters", () => {
    // Bytes chosen so standard base64 would contain '+', '/', and padding.
    const bytes = new Uint8Array([251, 255, 191]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("decodes a value with or without explicit padding equivalently", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const encoded = base64UrlEncode(bytes);
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 of an empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known SHA-256 of a short ASCII string", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic for the same input", async () => {
    expect(await sha256Hex("same input")).toBe(await sha256Hex("same input"));
  });

  it("differs for different input (pepper mixing changes the hash)", async () => {
    expect(await sha256Hex("pepper1:token")).not.toBe(await sha256Hex("pepper2:token"));
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(timingSafeEqual("short", "longer-string")).toBe(false);
  });

  it("returns false comparing against an empty string", () => {
    expect(timingSafeEqual("nonempty", "")).toBe(false);
  });
});
