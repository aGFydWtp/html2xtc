// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { logAuditEvent } from "../security/audit";
import type { Env } from "../types";

/**
 * Phase 7 (plan §19) scheduled cleanup of expired APP_DB rows: auth
 * challenges, device pairings, sessions, registration invites, and (登録
 * モード仕様 Phase2 §4b) registration_events — the tables that otherwise
 * only ever grow. Invoked once per day off the back
 * of the existing Aozora-sync cron (src/index.ts's scheduled()); no
 * dedicated cron of its own (plan doesn't call for a separate schedule).
 *
 * Every table's DELETE is independent and best-effort: a D1 failure on one
 * table is caught and logged without blocking the others, and cleanupAppDb
 * itself never throws — a bad day here just means slightly more rows linger
 * until tomorrow's cron retries the same unconditional WHERE clauses.
 *
 * device_pairings gets the most scrutiny: the plan requires that a row
 * carrying encrypted_device_token never survives past its own expires_at,
 * *whatever* its status (including 'approved', where a device may still be
 * mid-poll for that very token). Rather than special-case 'approved', this
 * module accepts the plan's explicit tradeoff — expires_at < now deletes the
 * row regardless of status — documented at the query below.
 */

const DEVICE_PAIRING_RETENTION_DAYS = 7;
const SESSION_REVOKED_RETENTION_DAYS = 30;
const INVITE_CONSUMED_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Every cutoff timestamp the DELETE statements below need, derived from a single injected `now`. */
export interface CleanupCutoffs {
  nowIso: string;
  devicePairingRetentionCutoffIso: string;
  sessionRevokedRetentionCutoffIso: string;
  inviteConsumedRetentionCutoffIso: string;
}

/**
 * Pure: derives every cutoff timestamp from `now`, so the day-offset
 * arithmetic is unit-testable without D1 (see test/db-cleanup.test.ts).
 */
export function computeCleanupCutoffs(now: Date): CleanupCutoffs {
  const nowMs = now.getTime();
  return {
    nowIso: now.toISOString(),
    devicePairingRetentionCutoffIso: new Date(
      nowMs - DEVICE_PAIRING_RETENTION_DAYS * MS_PER_DAY,
    ).toISOString(),
    sessionRevokedRetentionCutoffIso: new Date(
      nowMs - SESSION_REVOKED_RETENTION_DAYS * MS_PER_DAY,
    ).toISOString(),
    inviteConsumedRetentionCutoffIso: new Date(
      nowMs - INVITE_CONSUMED_RETENTION_DAYS * MS_PER_DAY,
    ).toISOString(),
  };
}

/** Rows removed per table by the most recent cleanupAppDb() run — no secrets, just counts. */
export interface CleanupCounts {
  authChallenges: number;
  devicePairings: number;
  sessions: number;
  registrationInvites: number;
  registrationEvents: number;
}

/** Runs one table's DELETE and returns rows removed, or 0 (logged) on failure — isolates one table's D1 error from the others. */
async function deleteBestEffort(
  db: D1Database,
  table: string,
  sql: string,
  params: unknown[],
): Promise<number> {
  try {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .run();
    return result.meta.changes ?? 0;
  } catch (error) {
    console.error(`app-db cleanup: ${table} delete failed`, error);
    return 0;
  }
}

/**
 * Deletes expired/stale rows from every APP_DB table with a retention rule
 * (plan §19), logs one app_db.cleanup.completed audit event with per-table
 * counts, and returns those counts. `now` defaults to the real clock but is
 * injectable for tests. Never throws — see module doc.
 */
export async function cleanupAppDb(
  env: Pick<Env, "APP_DB">,
  now: Date = new Date(),
): Promise<CleanupCounts> {
  const cutoffs = computeCleanupCutoffs(now);
  const db = env.APP_DB;

  // Expired (never claimed) or already-consumed challenges have no further
  // use to anyone.
  const authChallenges = await deleteBestEffort(
    db,
    "auth_challenges",
    `DELETE FROM auth_challenges WHERE expires_at < ? OR consumed_at IS NOT NULL`,
    [cutoffs.nowIso],
  );

  // expires_at < now fires for *any* status, including 'approved' — see the
  // module doc: encrypted_device_token must never outlive expires_at, and
  // this is the only condition that guarantees it (approved rows have no
  // separate expiry of their own). Since expires_at is fixed at creation
  // (10 minutes out) and never extended, in practice this first condition
  // deletes EVERY row — terminal (completed/rejected/expired) ones included —
  // at the first daily cron after creation. The second branch is a safety
  // net only: it becomes load-bearing if a future change ever extends
  // expires_at, capping terminal-row retention at 7 days.
  const devicePairings = await deleteBestEffort(
    db,
    "device_pairings",
    `DELETE FROM device_pairings
     WHERE expires_at < ?
        OR (
          status IN ('completed', 'rejected', 'expired')
          AND COALESCE(completed_at, created_at) < ?
        )`,
    [cutoffs.nowIso, cutoffs.devicePairingRetentionCutoffIso],
  );

  // A session past its own expiry is gone regardless of revocation; a
  // revoked-but-not-yet-expired session is kept for 30 days (matches
  // SESSION_TTL_DAYS's default order of magnitude) so a "list my recent
  // sign-outs" feature would still have something to show.
  const sessions = await deleteBestEffort(
    db,
    "sessions",
    `DELETE FROM sessions
     WHERE expires_at < ?
        OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
    [cutoffs.nowIso, cutoffs.sessionRevokedRetentionCutoffIso],
  );

  // An expired-and-never-used invite is deleted immediately (it can never be
  // consumed); a consumed invite is kept for 30 days as an audit trail of
  // "who registered off which invite" before being swept.
  const registrationInvites = await deleteBestEffort(
    db,
    "registration_invites",
    `DELETE FROM registration_invites
     WHERE (expires_at < ? AND consumed_at IS NULL)
        OR (consumed_at IS NOT NULL AND consumed_at < ?)`,
    [cutoffs.nowIso, cutoffs.inviteConsumedRetentionCutoffIso],
  );

  // registration_events (登録モード仕様 Phase2 §4b/§3): expires_at is set at
  // insert time (7 days out, src/auth/webauthn.ts's
  // REGISTRATION_EVENT_RETENTION_MS), so — unlike device_pairings above —
  // no separate retention-window cutoff is needed here; expires_at < now is
  // the whole rule.
  const registrationEvents = await deleteBestEffort(
    db,
    "registration_events",
    `DELETE FROM registration_events WHERE expires_at < ?`,
    [cutoffs.nowIso],
  );

  const counts: CleanupCounts = {
    authChallenges,
    devicePairings,
    sessions,
    registrationInvites,
    registrationEvents,
  };
  // Spread into a fresh object literal: logAuditEvent's forbidden-key guard
  // only applies to object literals (it needs the extra properties to be
  // structurally checkable), not to a value already typed as the CleanupCounts
  // interface.
  logAuditEvent("app_db.cleanup.completed", { ...counts });
  return counts;
}
