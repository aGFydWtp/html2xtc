import { describe, expect, it } from "vitest";
import {
  buildDeviceLibraryEntries,
  checkVersionMatch,
  validateItemIdsShape,
} from "../src/devices/service";

const UUID_A = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";
const UUID_B = "1a2b3c4d-5e6f-4a1b-8c9d-0f6ff35e3f8a";

describe("checkVersionMatch", () => {
  it("does not throw when versions match", () => {
    expect(() => checkVersionMatch(4, 4)).not.toThrow();
  });

  it("throws a 409 VERSION_CONFLICT when versions differ", () => {
    expect(() => checkVersionMatch(4, 3)).toThrow();
    expect.assertions(3);
    try {
      checkVersionMatch(4, 3);
    } catch (error) {
      expect((error as { status: number }).status).toBe(409);
      expect((error as { code: string }).code).toBe("VERSION_CONFLICT");
    }
  });
});

describe("validateItemIdsShape", () => {
  it("accepts an empty array", () => {
    expect(validateItemIdsShape([])).toEqual([]);
  });

  it("accepts an array of valid UUIDs, preserving order", () => {
    expect(validateItemIdsShape([UUID_A, UUID_B])).toEqual([UUID_A, UUID_B]);
  });

  it("rejects a non-array", () => {
    expect(() => validateItemIdsShape("not-an-array")).toThrow();
  });

  it("rejects a non-string element", () => {
    expect(() => validateItemIdsShape([UUID_A, 123])).toThrow();
  });

  it("rejects a duplicate id", () => {
    expect(() => validateItemIdsShape([UUID_A, UUID_A])).toThrow();
  });

  it("rejects a non-UUID id", () => {
    expect(() => validateItemIdsShape(["not-a-uuid"])).toThrow();
  });
});

describe("buildDeviceLibraryEntries", () => {
  it("assigns 0-based positions in itemIds order", () => {
    expect(buildDeviceLibraryEntries([UUID_A, UUID_B], "2026-01-01T00:00:00.000Z")).toEqual([
      { libraryItemId: UUID_A, position: 0, addedAt: "2026-01-01T00:00:00.000Z" },
      { libraryItemId: UUID_B, position: 1, addedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("returns an empty array for an empty itemIds list", () => {
    expect(buildDeviceLibraryEntries([], "2026-01-01T00:00:00.000Z")).toEqual([]);
  });
});
