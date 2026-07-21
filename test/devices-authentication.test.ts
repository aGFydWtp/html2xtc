import { describe, expect, it } from "vitest";
import { parseBasicAuthHeader } from "../src/devices/authentication";

function basicHeader(deviceId: string, deviceToken: string): string {
  return `Basic ${btoa(`${deviceId}:${deviceToken}`)}`;
}

describe("parseBasicAuthHeader", () => {
  it("parses a well-formed Basic header", () => {
    expect(parseBasicAuthHeader(basicHeader("device-1", "tok123"))).toEqual({
      deviceId: "device-1",
      deviceToken: "tok123",
    });
  });

  it("returns null for a missing header", () => {
    expect(parseBasicAuthHeader(null)).toBeNull();
  });

  it("returns null for a non-Basic scheme", () => {
    expect(parseBasicAuthHeader("Bearer abc123")).toBeNull();
  });

  it("rejects malformed base64", () => {
    expect(parseBasicAuthHeader("Basic not-valid-base64!!")).toBeNull();
  });

  it("returns null when there is no colon separator", () => {
    expect(parseBasicAuthHeader(`Basic ${btoa("no-colon-here")}`)).toBeNull();
  });

  it("returns null for an empty deviceId", () => {
    expect(parseBasicAuthHeader(`Basic ${btoa(":token")}`)).toBeNull();
  });

  it("returns null for an empty deviceToken", () => {
    expect(parseBasicAuthHeader(`Basic ${btoa("device-1:")}`)).toBeNull();
  });

  it("splits on the first colon only, keeping later colons in the token", () => {
    expect(parseBasicAuthHeader(basicHeader("device-1", "tok:with:colons"))).toEqual({
      deviceId: "device-1",
      deviceToken: "tok:with:colons",
    });
  });
});
