// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { resolveDeviceTag } from "../src/lib/device-tag";

describe("resolveDeviceTag", () => {
  it("returns x4 when device is x4", () => {
    expect(resolveDeviceTag("x4")).toBe("x4");
  });

  it("returns x3 when device is x3", () => {
    expect(resolveDeviceTag("x3")).toBe("x3");
  });

  it("falls back to x3 when device is missing (pre-device-selection era jobs were always X3)", () => {
    expect(resolveDeviceTag(undefined)).toBe("x3");
  });

  it("falls back to x3 for an unrecognized device value", () => {
    expect(resolveDeviceTag("unknown-device")).toBe("x3");
  });
});
