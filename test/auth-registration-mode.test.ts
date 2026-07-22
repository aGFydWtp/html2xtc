// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  isPublicRegistrationClosedReason,
  resolveRegistrationClosedReason,
  resolveRegistrationMode,
} from "../src/auth/registration-mode";

describe("resolveRegistrationMode", () => {
  it("defaults to invite when unset", () => {
    expect(resolveRegistrationMode({})).toBe("invite");
  });

  it("falls back to invite on garbage values", () => {
    expect(resolveRegistrationMode({ REGISTRATION_MODE: "banana" })).toBe("invite");
    expect(resolveRegistrationMode({ REGISTRATION_MODE: "" })).toBe("invite");
    expect(resolveRegistrationMode({ REGISTRATION_MODE: "INVITE" })).toBe("invite");
  });

  it("resolves 'open'", () => {
    expect(resolveRegistrationMode({ REGISTRATION_MODE: "open" })).toBe("open");
  });

  it("resolves 'closed'", () => {
    expect(resolveRegistrationMode({ REGISTRATION_MODE: "closed" })).toBe("closed");
  });

  it("resolves 'invite' explicitly", () => {
    expect(resolveRegistrationMode({ REGISTRATION_MODE: "invite" })).toBe("invite");
  });
});

describe("resolveRegistrationClosedReason", () => {
  it("returns null when unset", () => {
    expect(resolveRegistrationClosedReason({})).toBeNull();
  });

  it("returns null on an unknown value (never throws, never fabricates a reason)", () => {
    expect(resolveRegistrationClosedReason({ REGISTRATION_CLOSED_REASON: "banana" })).toBeNull();
    expect(resolveRegistrationClosedReason({ REGISTRATION_CLOSED_REASON: "" })).toBeNull();
  });

  it("resolves each of the 5 known values", () => {
    for (const value of ["maintenance", "capacity", "manual", "security", "abuse"] as const) {
      expect(resolveRegistrationClosedReason({ REGISTRATION_CLOSED_REASON: value })).toBe(value);
    }
  });
});

describe("isPublicRegistrationClosedReason", () => {
  it("maintenance/capacity/manual are public", () => {
    expect(isPublicRegistrationClosedReason("maintenance")).toBe(true);
    expect(isPublicRegistrationClosedReason("capacity")).toBe(true);
    expect(isPublicRegistrationClosedReason("manual")).toBe(true);
  });

  it("security/abuse are not public", () => {
    expect(isPublicRegistrationClosedReason("security")).toBe(false);
    expect(isPublicRegistrationClosedReason("abuse")).toBe(false);
  });
});
