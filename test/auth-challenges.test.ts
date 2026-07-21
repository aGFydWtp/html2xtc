import { describe, expect, it } from "vitest";
import { isChallengeConsumable } from "../src/auth/challenges";

describe("isChallengeConsumable", () => {
  const T0 = 1_700_000_000_000;

  it("is consumable before expiry and not yet consumed", () => {
    expect(
      isChallengeConsumable({ consumedAt: null, expiresAt: new Date(T0 + 1000).toISOString() }, T0),
    ).toBe(true);
  });

  it("rejects an expired challenge", () => {
    expect(
      isChallengeConsumable({ consumedAt: null, expiresAt: new Date(T0 - 1000).toISOString() }, T0),
    ).toBe(false);
  });

  it("treats the expiry instant itself as expired (strict greater-than)", () => {
    expect(
      isChallengeConsumable({ consumedAt: null, expiresAt: new Date(T0).toISOString() }, T0),
    ).toBe(false);
  });

  it("rejects an already-consumed challenge even if not yet expired", () => {
    expect(
      isChallengeConsumable(
        { consumedAt: new Date(T0 - 500).toISOString(), expiresAt: new Date(T0 + 1000).toISOString() },
        T0,
      ),
    ).toBe(false);
  });
});
