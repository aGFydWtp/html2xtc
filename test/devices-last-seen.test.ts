import { describe, expect, it } from "vitest";
import { LAST_SEEN_UPDATE_THROTTLE_MS, shouldUpdateLastSeen } from "../src/devices/last-seen";

const NOW = "2026-07-21T12:00:00.000Z";

describe("shouldUpdateLastSeen", () => {
  it("is true on a device's first sighting (lastSeenAt is null)", () => {
    expect(shouldUpdateLastSeen(null, NOW)).toBe(true);
  });

  it("is false when the previous update is within the throttle window", () => {
    const recent = new Date(new Date(NOW).getTime() - 1000).toISOString(); // 1s ago
    expect(shouldUpdateLastSeen(recent, NOW)).toBe(false);
  });

  it("is false exactly at the boundary minus one millisecond", () => {
    const almostStale = new Date(
      new Date(NOW).getTime() - (LAST_SEEN_UPDATE_THROTTLE_MS - 1),
    ).toISOString();
    expect(shouldUpdateLastSeen(almostStale, NOW)).toBe(false);
  });

  it("is true exactly at the throttle boundary", () => {
    const atBoundary = new Date(new Date(NOW).getTime() - LAST_SEEN_UPDATE_THROTTLE_MS).toISOString();
    expect(shouldUpdateLastSeen(atBoundary, NOW)).toBe(true);
  });

  it("is true once the previous update is older than the throttle window", () => {
    const stale = new Date(new Date(NOW).getTime() - LAST_SEEN_UPDATE_THROTTLE_MS - 1).toISOString();
    expect(shouldUpdateLastSeen(stale, NOW)).toBe(true);
  });

  it("honors a custom throttle override", () => {
    const twoMinutesAgo = new Date(new Date(NOW).getTime() - 2 * 60 * 1000).toISOString();
    expect(shouldUpdateLastSeen(twoMinutesAgo, NOW, 60 * 1000)).toBe(true);
    expect(shouldUpdateLastSeen(twoMinutesAgo, NOW, 5 * 60 * 1000)).toBe(false);
  });
});
