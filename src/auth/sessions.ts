// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { resolveMaxActiveSessionsPerAccount } from "../quotas";
import { logAuditEvent } from "../security/audit";
import { randomToken, sha256Hex } from "../security/crypto";
import { Errors } from "../security/errors";
import type { Env } from "../types";

/**
 * Server-side session management: token generation, SESSION_PEPPER-hashed
 * D1 storage, verification, and revocation. Login/registration themselves
 * (WebAuthn) are a later phase — this module only provides the primitives
 * that phase's login/logout endpoints will call, plus requireSession() for
 * every session-gated route added from here on (library, and later
 * devices/pairings).
 *
 * Cookie: __Host-html2xtc_session, Secure + HttpOnly + SameSite=Lax + Path=/
 * (plan §5.1). Only the token's peppered SHA-256 hash is ever persisted;
 * the raw token exists solely in the Set-Cookie response and the browser's
 * cookie jar.
 */

/**
 * __Host- prefix requires (browser-enforced): Secure, Path=/, no Domain
 * attribute — exactly what buildSessionCookie sets below.
 */
export const SESSION_COOKIE_NAME = "__Host-html2xtc_session";

const DEFAULT_SESSION_TTL_DAYS = 30;
const SESSION_TOKEN_BYTES = 32;

/** The authenticated principal returned by requireSession(). */
export interface Account {
  id: string;
  displayName: string;
}

/** Session TTL in days; SESSION_TTL_DAYS overrides the 30-day default (same fallback shape as resolveMaxPdfBytes, src/jobs.ts: non-positive/non-numeric values fall back, never disable expiry). */
export function resolveSessionTtlDays(env: Pick<Env, "SESSION_TTL_DAYS">): number {
  const configured = Number(env.SESSION_TTL_DAYS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SESSION_TTL_DAYS;
}

/** Reads SESSION_PEPPER or throws — a missing pepper is a deploy/config error, never a value to silently substitute for. */
function resolveSessionPepper(env: Pick<Env, "SESSION_PEPPER">): string {
  if (env.SESSION_PEPPER === undefined || env.SESSION_PEPPER.length === 0) {
    throw new Error("SESSION_PEPPER is not configured");
  }
  return env.SESSION_PEPPER;
}

/** Generates a fresh high-entropy session token (32 random bytes, base64url). Never persisted raw — only its hash (see hashSessionToken). */
export function generateSessionToken(): string {
  return randomToken(SESSION_TOKEN_BYTES);
}

/** Hashes a raw session token together with the SESSION_PEPPER secret; this is the only form written to D1 (sessions.token_hash). */
export async function hashSessionToken(token: string, pepper: string): Promise<string> {
  return sha256Hex(`${pepper}:${token}`);
}

/** Set-Cookie value for a freshly issued session. */
export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** Set-Cookie value that immediately expires the session cookie (logout). */
export function buildExpiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Extracts the session token from a request's Cookie header, or null if absent. */
export function parseSessionCookie(request: Request): string | null {
  return parseCookieHeader(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
}

/**
 * Pure Cookie-header parser (no Request dependency, so directly
 * unit-testable): returns the value of the named cookie, or null if the
 * header is absent or doesn't contain it.
 */
export function parseCookieHeader(header: string | null, name: string): string | null {
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** Shape of a sessions+accounts join row needed to decide validity. */
export interface SessionRecord {
  accountId: string;
  displayName: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface SessionJoinRow {
  session_id: string;
  account_id: string;
  display_name: string;
  expires_at: string;
  revoked_at: string | null;
}

/**
 * Pure validity decision extracted out of requireSession so it is
 * unit-testable without D1: a session is valid iff it hasn't been revoked
 * and its expiry is still in the future.
 */
export function isSessionValid(record: SessionRecord, nowMs: number): boolean {
  if (record.revokedAt !== null) {
    return false;
  }
  return new Date(record.expiresAt).getTime() > nowMs;
}

/** Counts an account's active (not revoked, not expired) sessions — the "sessions" quota (登録モード仕様 Phase1 §5.3). */
export async function countActiveSessions(env: Pick<Env, "APP_DB">, accountId: string): Promise<number> {
  const row = await env.APP_DB.prepare(
    `SELECT COUNT(*) AS count FROM sessions WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(accountId, new Date().toISOString())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** Revokes the account's oldest active session (by created_at) — used by createSession when the session quota is already met. Returns false if there was no active session to revoke (can only happen if the quota is 0 or a concurrent revoke won first). */
async function revokeOldestActiveSession(env: Pick<Env, "APP_DB">, accountId: string): Promise<boolean> {
  const oldest = await env.APP_DB.prepare(
    `SELECT id FROM sessions WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(accountId, new Date().toISOString())
    .first<{ id: string }>();
  if (oldest === null) {
    return false;
  }
  const result = await env.APP_DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), oldest.id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Persists a new session for accountId and returns the raw token (set as
 * the session Cookie) plus its ISO-8601 UTC expiry. Only the token's
 * peppered SHA-256 hash is written to D1. Called by the login/registration-
 * verify routes (src/auth/webauthn.ts).
 *
 * Session quota (登録モード仕様 Phase1 §5.3): when the account is already at
 * MAX_ACTIVE_SESSIONS_PER_ACCOUNT, the oldest active session is revoked to
 * make room before the new one is issued — a session limit reads as "your
 * least-recently-created session was signed out", not a hard failure, unless
 * revocation itself somehow finds nothing to revoke (a concurrent revoke won
 * first), in which case this throws 409 SESSION_LIMIT_EXCEEDED rather than
 * silently exceeding the quota.
 */
export async function createSession(
  env: Pick<Env, "APP_DB" | "SESSION_PEPPER" | "SESSION_TTL_DAYS" | "MAX_ACTIVE_SESSIONS_PER_ACCOUNT">,
  accountId: string,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: string; maxAgeSeconds: number }> {
  const activeSessionCount = await countActiveSessions(env, accountId);
  if (activeSessionCount >= resolveMaxActiveSessionsPerAccount(env)) {
    const revoked = await revokeOldestActiveSession(env, accountId);
    if (!revoked) {
      logAuditEvent("account.quota.exceeded", { accountId, quota: "sessions" });
      throw Errors.conflict("SESSION_LIMIT_EXCEEDED", "session limit reached");
    }
  }

  const token = generateSessionToken();
  const pepper = resolveSessionPepper(env);
  const tokenHash = await hashSessionToken(token, pepper);
  const ttlDays = resolveSessionTtlDays(env);
  const maxAgeSeconds = ttlDays * 24 * 60 * 60;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + maxAgeSeconds * 1000);
  const nowIso = now.toISOString();

  await env.APP_DB.prepare(
    `INSERT INTO sessions (id, account_id, token_hash, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      accountId,
      tokenHash,
      userAgent,
      nowIso,
      nowIso,
      expiresAt.toISOString(),
    )
    .run();

  return { token, expiresAt: expiresAt.toISOString(), maxAgeSeconds };
}

/** Internal: loads the sessions+accounts join row for the request's session cookie, without yet deciding validity — shared by requireSession and requireSessionWithId. */
async function loadSessionRecord(
  request: Request,
  env: Pick<Env, "APP_DB" | "SESSION_PEPPER">,
): Promise<{ sessionId: string; record: SessionRecord } | null> {
  const token = parseSessionCookie(request);
  if (token === null) {
    return null;
  }

  let pepper: string;
  try {
    pepper = resolveSessionPepper(env);
  } catch (error) {
    console.error("session verification unavailable", error);
    return null;
  }

  const tokenHash = await hashSessionToken(token, pepper);
  const row = await env.APP_DB.prepare(
    `SELECT s.id AS session_id, s.account_id, a.display_name, s.expires_at, s.revoked_at
     FROM sessions AS s
     JOIN accounts AS a ON a.id = s.account_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<SessionJoinRow>();
  if (row === null) {
    return null;
  }

  return {
    sessionId: row.session_id,
    record: {
      accountId: row.account_id,
      displayName: row.display_name,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    },
  };
}

/**
 * Verifies the session cookie on `request` and returns the authenticated
 * Account, or null when there is no cookie, the token doesn't match any
 * session, the session is revoked, or it has expired. This is the auth gate
 * for every session-protected route (library, and the new /api/me* and
 * passkey-management routes).
 */
export async function requireSession(
  request: Request,
  env: Pick<Env, "APP_DB" | "SESSION_PEPPER">,
): Promise<Account | null> {
  const loaded = await loadSessionRecord(request, env);
  if (loaded === null || !isSessionValid(loaded.record, Date.now())) {
    return null;
  }
  return { id: loaded.record.accountId, displayName: loaded.record.displayName };
}

/** Same validity check as requireSession, but also returns the session's own id — needed by GET /api/me/sessions to mark which row is "this session". */
export async function requireSessionWithId(
  request: Request,
  env: Pick<Env, "APP_DB" | "SESSION_PEPPER">,
): Promise<{ account: Account; sessionId: string } | null> {
  const loaded = await loadSessionRecord(request, env);
  if (loaded === null || !isSessionValid(loaded.record, Date.now())) {
    return null;
  }
  return {
    account: { id: loaded.record.accountId, displayName: loaded.record.displayName },
    sessionId: loaded.sessionId,
  };
}

/** Revokes a session by its raw token (logout). No-op if the token is unknown or already revoked. */
export async function revokeSessionByToken(
  env: Pick<Env, "APP_DB" | "SESSION_PEPPER">,
  token: string,
): Promise<void> {
  const pepper = resolveSessionPepper(env);
  const tokenHash = await hashSessionToken(token, pepper);
  await env.APP_DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), tokenHash)
    .run();
}

/** Summary of one session for GET /api/me/sessions — no token_hash, ever. */
export interface SessionSummary {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface SessionSummaryRow {
  id: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

/** Lists an account's active (not revoked, not expired) sessions, most recent first. Never selects token_hash. */
export async function listSessionsForAccount(
  env: Pick<Env, "APP_DB">,
  accountId: string,
): Promise<SessionSummary[]> {
  const result = await env.APP_DB.prepare(
    `SELECT id, user_agent, created_at, last_seen_at, expires_at
     FROM sessions
     WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC`,
  )
    .bind(accountId, new Date().toISOString())
    .all<SessionSummaryRow>();
  return result.results.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  }));
}

/** Revokes one session by id, scoped to accountId so an account can only ever revoke its own sessions (plan §16 "端末は必ずaccount_idでスコープする" — the same principle applied to sessions). Returns false if no matching, still-active session was found. */
export async function revokeSessionById(
  env: Pick<Env, "APP_DB">,
  accountId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await env.APP_DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), sessionId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
