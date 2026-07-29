// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_DEVICE_PROFILE,
  DEVICE_PROFILES,
  isDeviceId,
  resolveDeviceId,
  resolveDeviceProfile,
} from "../src/devices";

describe("DEVICE_PROFILES", () => {
  it("X3: 528x792 px, 66mm x 99mm page, 4mm margin, 528px image target", () => {
    expect(DEVICE_PROFILES.x3).toEqual({
      id: "x3",
      outputWidthPx: 528,
      outputHeightPx: 792,
      pageWidthMm: 66,
      pageHeightMm: 99,
      marginMm: 4,
      imageTargetWidthPx: 528,
    });
  });

  it("X4: 480x800 px, 60mm x 100mm page, 4mm margin, 480px image target", () => {
    expect(DEVICE_PROFILES.x4).toEqual({
      id: "x4",
      outputWidthPx: 480,
      outputHeightPx: 800,
      pageWidthMm: 60,
      pageHeightMm: 100,
      marginMm: 4,
      imageTargetWidthPx: 480,
    });
  });

  it("keeps the X3 px/mm ratio (8) on X4 too, deliberately", () => {
    expect(DEVICE_PROFILES.x3.outputWidthPx / DEVICE_PROFILES.x3.pageWidthMm).toBe(8);
    expect(DEVICE_PROFILES.x4.outputWidthPx / DEVICE_PROFILES.x4.pageWidthMm).toBe(8);
  });

  it("defaults to the X3 profile", () => {
    expect(DEFAULT_DEVICE_ID).toBe("x3");
    expect(DEFAULT_DEVICE_PROFILE).toEqual(DEVICE_PROFILES.x3);
  });
});

describe("isDeviceId", () => {
  it("accepts exactly \"x3\" and \"x4\"", () => {
    expect(isDeviceId("x3")).toBe(true);
    expect(isDeviceId("x4")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of [undefined, null, "", "X3", "x5", 3, {}, []]) {
      expect(isDeviceId(value)).toBe(false);
    }
  });
});

describe("resolveDeviceId / resolveDeviceProfile — fail-soft", () => {
  it("resolves explicit x3/x4", () => {
    expect(resolveDeviceId("x3")).toBe("x3");
    expect(resolveDeviceId("x4")).toBe("x4");
    expect(resolveDeviceProfile("x4")).toEqual(DEVICE_PROFILES.x4);
  });

  it("falls back to x3 for undefined, wrong type, or an unrecognized string (never throws)", () => {
    for (const value of [undefined, null, "", "x5", "X4", 4, {}]) {
      expect(resolveDeviceId(value)).toBe("x3");
      expect(resolveDeviceProfile(value)).toEqual(DEVICE_PROFILES.x3);
    }
  });
});
