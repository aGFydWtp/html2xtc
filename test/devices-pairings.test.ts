import { describe, expect, it } from "vitest";
import {
  decidePairingStatus,
  generateUserCode,
  isPairingApprovable,
  isPairingCompletable,
  isPairingRejectable,
  normalizeUserCode,
  parsePairingSecretHeader,
} from "../src/devices/pairings";

describe("generateUserCode", () => {
  it("produces an 8-character code formatted as XXXX-XXXX", () => {
    expect(generateUserCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("never contains ambiguous characters (O, 0, I, 1)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateUserCode()).not.toMatch(/[O0I1]/);
    }
  });

  it("produces different codes across calls", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateUserCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("normalizeUserCode", () => {
  it("uppercases and re-hyphenates a lowercase, unhyphenated code", () => {
    expect(normalizeUserCode("abcd2345")).toBe("ABCD-2345");
  });

  it("accepts a code already in canonical form", () => {
    expect(normalizeUserCode("ABCD-2345")).toBe("ABCD-2345");
  });

  it("strips stray whitespace and punctuation", () => {
    expect(normalizeUserCode(" abcd-2345 ")).toBe("ABCD-2345");
  });

  it("rejects the wrong length", () => {
    expect(normalizeUserCode("ABCD-234")).toBeNull();
    expect(normalizeUserCode("ABCD-23456")).toBeNull();
  });

  it("rejects ambiguous excluded characters (O/0/I/1)", () => {
    expect(normalizeUserCode("ABCO-2345")).toBeNull();
    expect(normalizeUserCode("ABC0-2345")).toBeNull();
    expect(normalizeUserCode("ABCI-2345")).toBeNull();
    expect(normalizeUserCode("ABC1-2345")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(normalizeUserCode("")).toBeNull();
  });
});

const T0 = 1_700_000_000_000;

describe("decidePairingStatus", () => {
  it("virtualizes a pending row past its expiresAt as 'expired'", () => {
    expect(
      decidePairingStatus({ status: "pending", expiresAt: new Date(T0 - 1000).toISOString() }, T0),
    ).toBe("expired");
  });

  it("keeps 'pending' for a pending row not yet expired", () => {
    expect(
      decidePairingStatus({ status: "pending", expiresAt: new Date(T0 + 1000).toISOString() }, T0),
    ).toBe("pending");
  });

  it("passes through approved/rejected/completed regardless of expiresAt", () => {
    for (const status of ["approved", "rejected", "completed"]) {
      expect(
        decidePairingStatus({ status, expiresAt: new Date(T0 - 1000).toISOString() }, T0),
      ).toBe(status);
    }
  });
});

describe("isPairingApprovable / isPairingRejectable / isPairingCompletable", () => {
  const pending = { status: "pending", expiresAt: new Date(T0 + 1000).toISOString() };
  const expiredPending = { status: "pending", expiresAt: new Date(T0 - 1000).toISOString() };
  const approved = { status: "approved", expiresAt: new Date(T0 + 1000).toISOString() };
  const rejected = { status: "rejected", expiresAt: new Date(T0 + 1000).toISOString() };
  const completed = { status: "completed", expiresAt: new Date(T0 + 1000).toISOString() };

  it("only a pending, unexpired row is approvable (guards against double approval)", () => {
    expect(isPairingApprovable(pending, T0)).toBe(true);
    expect(isPairingApprovable(expiredPending, T0)).toBe(false);
    expect(isPairingApprovable(approved, T0)).toBe(false);
    expect(isPairingApprovable(rejected, T0)).toBe(false);
    expect(isPairingApprovable(completed, T0)).toBe(false);
  });

  it("only a pending, unexpired row is rejectable", () => {
    expect(isPairingRejectable(pending, T0)).toBe(true);
    expect(isPairingRejectable(expiredPending, T0)).toBe(false);
    expect(isPairingRejectable(approved, T0)).toBe(false);
  });

  it("only an approved row is completable", () => {
    expect(isPairingCompletable(approved, T0)).toBe(true);
    expect(isPairingCompletable(pending, T0)).toBe(false);
    expect(isPairingCompletable(rejected, T0)).toBe(false);
    expect(isPairingCompletable(completed, T0)).toBe(false);
  });
});

describe("parsePairingSecretHeader", () => {
  it("extracts the secret from a well-formed header", () => {
    expect(parsePairingSecretHeader("Pairing abc123")).toBe("abc123");
  });

  it("returns null for a missing header", () => {
    expect(parsePairingSecretHeader(null)).toBeNull();
  });

  it("returns null for the wrong scheme", () => {
    expect(parsePairingSecretHeader("Bearer abc123")).toBeNull();
  });

  it("returns null for a blank secret", () => {
    expect(parsePairingSecretHeader("Pairing    ")).toBeNull();
  });
});
