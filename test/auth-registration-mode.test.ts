// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { resolveRegistrationMode } from "../src/auth/registration-mode";

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
