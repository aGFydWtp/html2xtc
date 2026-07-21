// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { computeCleanupCutoffs } from "../src/db/cleanup";

describe("computeCleanupCutoffs", () => {
  it("derives every cutoff from the injected `now`, with no cloudflare:* dependency", () => {
    const now = new Date("2026-07-21T18:30:00.000Z");

    const cutoffs = computeCleanupCutoffs(now);

    expect(cutoffs.nowIso).toBe("2026-07-21T18:30:00.000Z");
    // device_pairings retention: 7 days.
    expect(cutoffs.devicePairingRetentionCutoffIso).toBe("2026-07-14T18:30:00.000Z");
    // sessions (revoked) retention: 30 days.
    expect(cutoffs.sessionRevokedRetentionCutoffIso).toBe("2026-06-21T18:30:00.000Z");
    // registration_invites (consumed) retention: 30 days.
    expect(cutoffs.inviteConsumedRetentionCutoffIso).toBe("2026-06-21T18:30:00.000Z");
  });

  it("keeps every cutoff strictly before `now` (all are lookback windows)", () => {
    const now = new Date("2000-01-01T00:00:00.000Z");
    const cutoffs = computeCleanupCutoffs(now);
    const nowMs = now.getTime();

    expect(new Date(cutoffs.devicePairingRetentionCutoffIso).getTime()).toBeLessThan(nowMs);
    expect(new Date(cutoffs.sessionRevokedRetentionCutoffIso).getTime()).toBeLessThan(nowMs);
    expect(new Date(cutoffs.inviteConsumedRetentionCutoffIso).getTime()).toBeLessThan(nowMs);
  });
});
