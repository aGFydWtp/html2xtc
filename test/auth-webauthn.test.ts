import { describe, expect, it } from "vitest";
import {
  extractClientDataChallenge,
  resolveWebauthnOrigin,
  resolveWebauthnRpId,
  sanitizeDisplayName,
} from "../src/auth/webauthn";
import { base64UrlEncode } from "../src/security/crypto";
import { ApiError } from "../src/security/errors";

function clientDataJSONFor(challenge: string, extra: Record<string, unknown> = {}): string {
  const json = JSON.stringify({ type: "webauthn.create", challenge, origin: "https://xtc.hr20k.com", ...extra });
  return base64UrlEncode(new TextEncoder().encode(json));
}

describe("extractClientDataChallenge", () => {
  it("extracts the challenge from a well-formed clientDataJSON", () => {
    const challenge = "abc123-_XYZ";
    expect(extractClientDataChallenge(clientDataJSONFor(challenge))).toBe(challenge);
  });

  it("throws ApiError on malformed base64url", () => {
    expect(() => extractClientDataChallenge("not!valid!base64url!!!")).toThrow(ApiError);
  });

  it("throws ApiError when the decoded bytes aren't valid JSON", () => {
    const notJson = base64UrlEncode(new TextEncoder().encode("not json at all"));
    expect(() => extractClientDataChallenge(notJson)).toThrow(ApiError);
  });

  it("throws ApiError when challenge is missing", () => {
    const noChallenge = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", origin: "https://xtc.hr20k.com" })),
    );
    expect(() => extractClientDataChallenge(noChallenge)).toThrow(ApiError);
  });

  it("throws ApiError when challenge is not a string", () => {
    const badChallenge = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: 123 })),
    );
    expect(() => extractClientDataChallenge(badChallenge)).toThrow(ApiError);
  });
});

describe("sanitizeDisplayName", () => {
  it("trims and collapses whitespace", () => {
    expect(sanitizeDisplayName("  Haruki   Tanaka  ")).toBe("Haruki Tanaka");
  });

  it("strips control characters", () => {
    expect(sanitizeDisplayName("Haruki\x00\x1f\x7fTanaka")).toBe("Haruki Tanaka");
  });

  it("caps length at 100 characters", () => {
    expect(sanitizeDisplayName("a".repeat(200)).length).toBe(100);
  });
});

describe("resolveWebauthnRpId / resolveWebauthnOrigin", () => {
  it("returns the configured rpId", () => {
    expect(resolveWebauthnRpId({ WEBAUTHN_RP_ID: "xtc.hr20k.com" })).toBe("xtc.hr20k.com");
  });

  it("throws ApiError when rpId is unset", () => {
    expect(() => resolveWebauthnRpId({})).toThrow(ApiError);
  });

  it("throws ApiError when rpId is empty", () => {
    expect(() => resolveWebauthnRpId({ WEBAUTHN_RP_ID: "" })).toThrow(ApiError);
  });

  it("returns the configured origin", () => {
    expect(resolveWebauthnOrigin({ WEBAUTHN_ORIGIN: "https://xtc.hr20k.com" })).toBe("https://xtc.hr20k.com");
  });

  it("throws ApiError when origin is unset", () => {
    expect(() => resolveWebauthnOrigin({})).toThrow(ApiError);
  });
});
