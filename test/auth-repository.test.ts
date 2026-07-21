import { describe, expect, it } from "vitest";
import { isInviteUsable } from "../src/auth/repository";

describe("isInviteUsable", () => {
  const T0 = 1_700_000_000_000;

  it("is usable before expiry and not yet consumed", () => {
    expect(isInviteUsable({ consumedAt: null, expiresAt: new Date(T0 + 1000).toISOString() }, T0)).toBe(true);
  });

  it("rejects an expired invite", () => {
    expect(isInviteUsable({ consumedAt: null, expiresAt: new Date(T0 - 1000).toISOString() }, T0)).toBe(false);
  });

  it("treats the expiry instant itself as expired (strict greater-than)", () => {
    expect(isInviteUsable({ consumedAt: null, expiresAt: new Date(T0).toISOString() }, T0)).toBe(false);
  });

  it("rejects an already-consumed invite even if not yet expired", () => {
    expect(
      isInviteUsable(
        { consumedAt: new Date(T0 - 500).toISOString(), expiresAt: new Date(T0 + 1000).toISOString() },
        T0,
      ),
    ).toBe(false);
  });
});
