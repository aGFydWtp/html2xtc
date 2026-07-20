// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { randomToken, sha256Hex } from "../security/crypto";
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

/**
 * Persists a new session for accountId and returns the raw token (set as
 * the session Cookie) plus its ISO-8601 UTC expiry. Only the token's
 * peppered SHA-256 hash is written to D1. Intended to be called by the
 * login/registration-verify routes added in a later phase.
 */
export async function createSession(
  env: Pick<Env, "APP_DB" | "SESSION_PEPPER" | "SESSION_TTL_DAYS">,
  accountId: string,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: string; maxAgeSeconds: number }> {
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

/**
 * Verifies the session cookie on `request` and returns the authenticated
 * Account, or null when there is no cookie, the token doesn't match any
 * session, the session is revoked, or it has expired. This is the auth gate
 * for every session-protected route (library now; devices/pairings in a
 * later phase).
 */
export async function requireSession(
  request: Request,
  env: Pick<Env, "APP_DB" | "SESSION_PEPPER">,
): Promise<Account | null> {
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
    `SELECT s.account_id, a.display_name, s.expires_at, s.revoked_at
     FROM sessions AS s
     JOIN accounts AS a ON a.id = s.account_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<SessionJoinRow>();
  if (row === null) {
    return null;
  }

  const record: SessionRecord = {
    accountId: row.account_id,
    displayName: row.display_name,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
  if (!isSessionValid(record, Date.now())) {
    return null;
  }
  return { id: record.accountId, displayName: record.displayName };
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
