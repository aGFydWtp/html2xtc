// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url } from "../src/base64url";

describe("encodeBase64Url / decodeBase64Url round trip", () => {
  it("round-trips ASCII text", () => {
    const text = "document.pdf";
    expect(decodeBase64Url(encodeBase64Url(text))).toBe(text);
  });

  it("round-trips UTF-8 text (Japanese filename)", () => {
    const text = "請求書.pdf"; // 請求書.pdf
    expect(decodeBase64Url(encodeBase64Url(text))).toBe(text);
  });

  it("round-trips JSON text", () => {
    const text = JSON.stringify({ pages: "1-", rotation: 0 });
    expect(decodeBase64Url(encodeBase64Url(text))).toBe(text);
  });

  it("produces no '+', '/' or '=' characters (URL/header safe)", () => {
    // Bytes chosen so the un-substituted base64 would contain '+' and '/'.
    const encoded = encodeBase64Url("ûÿþ>?");
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("decodeBase64Url", () => {
  it("returns null for a non-base64url character", () => {
    expect(decodeBase64Url("not valid base64!")).toBeNull();
  });

  it("returns null for malformed base64 padding", () => {
    expect(decodeBase64Url("a")).toBeNull();
  });

  it("returns null for a byte sequence that is not valid UTF-8", () => {
    // Lone continuation byte (0x80) is never valid at the start of a UTF-8
    // sequence.
    const invalidUtf8 = btoa("\x80").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeBase64Url(invalidUtf8)).toBeNull();
  });

  it("accepts an empty string", () => {
    expect(decodeBase64Url("")).toBe("");
  });
});
