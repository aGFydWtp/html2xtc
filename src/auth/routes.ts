// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { countActiveDevices } from "../devices/repository";
import { countActiveLibraryItems, sumLibraryBytes } from "../library/repository";
import {
  resolveMaxActiveSessionsPerAccount,
  resolveMaxDevicesPerAccount,
  resolveMaxLibraryBytesPerAccount,
  resolveMaxLibraryItemsPerAccount,
  resolveMaxPasskeysPerAccount,
} from "../quotas";
import { enforcePurposeRateLimit } from "../ratelimiter";
import type { Router } from "../router";
import { logAuditEvent } from "../security/audit";
import { ApiError, Errors } from "../security/errors";
import type { Env } from "../types";
import { deleteAccountCompletely } from "./account-deletion";
import { verifyCsrf } from "./csrf";
import { deleteCredentialById, listCredentialsForAccount } from "./repository";
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  countActiveSessions,
  listSessionsForAccount,
  parseSessionCookie,
  requireSession,
  requireSessionWithId,
  revokeSessionById,
  revokeSessionByToken,
} from "./sessions";
import type { Account } from "./sessions";
import { finishLogin, finishRegistration, startLogin, startRegistration } from "./webauthn";
import type { FinishLoginResult } from "./webauthn";

/**
 * HTTP adapter for the Phase 2 passkey/session API (plan §9.1), registered
 * on the shared Router (src/router.ts). Mirrors src/library/routes.ts:
 * thin handlers that validate the request shape, delegate to
 * src/auth/webauthn.ts / src/auth/sessions.ts, and let ApiError propagate to
 * Router.handle's toErrorResponse. Session tokens are never put in a JSON
 * body — only in Set-Cookie (plan §5.1 "セッショントークンはJSONへ含めず").
 */

async function requireAccount(request: Request, env: Env): Promise<Account> {
  const account = await requireSession(request, env);
  if (account === null) {
    throw Errors.unauthorized();
  }
  return account;
}

function requireCsrf(request: Request, env: Env): void {
  const result = verifyCsrf(request, env);
  if (!result.ok) {
    throw Errors.forbidden("CSRF_REJECTED", result.reason);
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw Errors.badRequest("INVALID_JSON", "request body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw Errors.badRequest("INVALID_JSON", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function accountDto(account: Account): { id: string; displayName: string } {
  return { id: account.id, displayName: account.displayName };
}

/** GET /api/me/passkeys public DTO — never credentialId or the public key (登録モード仕様 Phase1 §5.6). */
function passkeyDto(credential: {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}): { id: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean } {
  return {
    id: credential.id,
    createdAt: credential.createdAt,
    lastUsedAt: credential.lastUsedAt,
    backedUp: credential.backedUp,
  };
}

/** plan §13's per-purpose table, plus 登録モード仕様 Phase1 §5.7/§8's additions. */
const REGISTRATION_START_LIMIT = 10;
const LOGIN_START_LIMIT = 30;
const LOGIN_VERIFY_FAILED_LIMIT = 30;
/** 登録検証失敗: 10/h/IP, fail-closed (登録モード仕様 Phase1 §5.7/§8b). */
const REGISTRATION_VERIFY_FAILED_LIMIT = 10;
/** 招待照合失敗: 20/h/IP, fail-closed (登録モード仕様 Phase1 §5.7/§8c). */
const INVITE_CHECK_FAILED_LIMIT = 20;
/** アカウント削除: 5/日/account, fail-closed (登録モード仕様 Phase1 §5.7/§8d). */
const ACCOUNT_DELETION_LIMIT = 5;
const ACCOUNT_DELETION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function registerAuthRoutes(router: Router): void {
  router.post("/api/auth/registration/options", async (request, env) => {
    // Passkey registration start: 10/h/IP, fail-closed (plan §13).
    const limited = await enforcePurposeRateLimit(request, env, {
      purpose: "auth.registration.start",
      limit: REGISTRATION_START_LIMIT,
      failClosed: true,
    });
    if (limited !== null) {
      return limited;
    }
    const body = await readJsonBody(request);
    const { inviteToken, displayName } = body;

    // A caller with a live session adds a passkey to their own account and
    // needs no invite; otherwise inviteToken+displayName create a new one.
    const existingAccount = await requireSession(request, env);
    if (existingAccount !== null) {
      const options = await startRegistration(env, { existingAccount });
      return Response.json({ options });
    }

    if (typeof inviteToken !== "string" || inviteToken.length === 0) {
      throw Errors.badRequest("INVITE_REQUIRED", "inviteToken is required");
    }
    if (typeof displayName !== "string" || displayName.length === 0) {
      throw Errors.badRequest("INVALID_DISPLAY_NAME", "displayName is required");
    }

    let options: Awaited<ReturnType<typeof startRegistration>>;
    try {
      options = await startRegistration(env, { invite: { inviteToken, displayName } });
    } catch (error) {
      // Invite照合失敗: 20/h/IP, fail-closed (登録モード仕様 Phase1 §5.7/§8c).
      // Only counts INVALID_INVITE/INVITE_REQUIRED — any other failure (e.g.
      // a REGISTRATION_CLOSED 403) isn't an invite-guessing attempt and
      // shouldn't share this budget.
      if (error instanceof ApiError && (error.code === "INVALID_INVITE" || error.code === "INVITE_REQUIRED")) {
        logAuditEvent("auth.registration.failed");
        const limited2 = await enforcePurposeRateLimit(request, env, {
          purpose: "auth.registration.invite_check_failed",
          limit: INVITE_CHECK_FAILED_LIMIT,
          failClosed: true,
        });
        if (limited2 !== null) {
          return limited2;
        }
      }
      throw error;
    }
    logAuditEvent("auth.registration.started");
    return Response.json({ options });
  });

  router.post("/api/auth/registration/verify", async (request, env) => {
    // Origin/Sec-Fetch-Site check even though no session exists yet: a
    // completed ceremony here still *establishes* one (session-fixation /
    // login-CSRF — plan §5.1's CSRF coverage was scoped to "変更系Cookie認証
    // API", but a cross-site POST of a self-completed WebAuthn ceremony would
    // otherwise silently log the victim into the attacker's account).
    requireCsrf(request, env);
    const body = await readJsonBody(request);
    const { response } = body;
    if (typeof response !== "object" || response === null) {
      throw Errors.badRequest("INVALID_RESPONSE", "response is required");
    }
    const userAgent = request.headers.get("User-Agent");
    let result: Awaited<ReturnType<typeof finishRegistration>>;
    try {
      result = await finishRegistration(env, response as RegistrationResponseJSON, userAgent);
    } catch (error) {
      // 登録検証失敗: 10/h/IP, fail-closed (登録モード仕様 Phase1 §5.7/§8b) —
      // same counted-on-failure-only shape as login/verify below.
      logAuditEvent("auth.registration.failed");
      const limited = await enforcePurposeRateLimit(request, env, {
        purpose: "auth.registration.verify_failed",
        limit: REGISTRATION_VERIFY_FAILED_LIMIT,
        failClosed: true,
      });
      if (limited !== null) {
        return limited;
      }
      throw error;
    }
    if (result.session !== null) {
      logAuditEvent("auth.registration.completed", { accountId: result.account.id });
    }
    logAuditEvent("passkey.added", { accountId: result.account.id });
    const headers = new Headers();
    if (result.session !== null) {
      headers.set("Set-Cookie", buildSessionCookie(result.session.token, result.session.maxAgeSeconds));
    }
    return Response.json({ account: accountDto(result.account) }, { headers });
  });

  router.post("/api/auth/login/options", async (request, env) => {
    // Passkey login start: 30/h/IP, fail-closed (plan §13).
    const limited = await enforcePurposeRateLimit(request, env, {
      purpose: "auth.login.start",
      limit: LOGIN_START_LIMIT,
      failClosed: true,
    });
    if (limited !== null) {
      return limited;
    }
    const options = await startLogin(env);
    return Response.json({ options });
  });

  router.post("/api/auth/login/verify", async (request, env) => {
    // Same login-CSRF defense as registration/verify above: this route also
    // establishes a session (Set-Cookie) despite requiring no prior one.
    requireCsrf(request, env);
    const body = await readJsonBody(request);
    const { response } = body;
    if (typeof response !== "object" || response === null) {
      throw Errors.badRequest("INVALID_RESPONSE", "response is required");
    }
    const userAgent = request.headers.get("User-Agent");
    let result: FinishLoginResult;
    try {
      result = await finishLogin(env, response as AuthenticationResponseJSON, userAgent);
    } catch (error) {
      // Login-verify failure: 30/h/IP, fail-closed (plan §13 "ログイン検証
      // 失敗"). Counted (and, past the threshold, enforced) only on failure —
      // a legitimate user's occasional wrong attempt never counts against
      // anyone else's budget, only repeated failures from one IP do. The
      // limiter check runs after the failure so this specific request still
      // gets its own honest 401 unless it is itself the one that trips the
      // threshold.
      logAuditEvent("auth.login.failed");
      const limited = await enforcePurposeRateLimit(request, env, {
        purpose: "auth.login.verify_failed",
        limit: LOGIN_VERIFY_FAILED_LIMIT,
        failClosed: true,
      });
      if (limited !== null) {
        return limited;
      }
      throw error;
    }
    logAuditEvent("auth.login.succeeded", { accountId: result.account.id });
    const headers = new Headers();
    headers.set("Set-Cookie", buildSessionCookie(result.session.token, result.session.maxAgeSeconds));
    return Response.json({ account: accountDto(result.account) }, { headers });
  });

  router.post("/api/auth/logout", async (request, env) => {
    requireCsrf(request, env);
    const token = parseSessionCookie(request);
    if (token !== null) {
      await revokeSessionByToken(env, token);
    }
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": buildExpiredSessionCookie() },
    });
  });

  router.get("/api/me", async (request, env) => {
    const account = await requireAccount(request, env);
    return Response.json({ account: accountDto(account) });
  });

  router.get("/api/me/sessions", async (request, env) => {
    const current = await requireSessionWithId(request, env);
    if (current === null) {
      throw Errors.unauthorized();
    }
    const sessions = await listSessionsForAccount(env, current.account.id);
    return Response.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        isCurrent: session.id === current.sessionId,
      })),
    });
  });

  router.delete("/api/me/sessions/:sessionId", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    const revoked = await revokeSessionById(env, account.id, params.sessionId);
    if (!revoked) {
      throw Errors.notFound("SESSION_NOT_FOUND", "session not found");
    }
    return new Response(null, { status: 204 });
  });

  // --- 登録モード仕様 Phase1 §5.4: usage ---

  router.get("/api/me/usage", async (request, env) => {
    const account = await requireAccount(request, env);
    const [libraryItemCount, libraryByteTotal, deviceCount, sessionCount, credentials] = await Promise.all([
      countActiveLibraryItems(env.APP_DB, account.id),
      sumLibraryBytes(env.APP_DB, account.id),
      countActiveDevices(env.APP_DB, account.id),
      countActiveSessions(env, account.id),
      listCredentialsForAccount(env.APP_DB, account.id),
    ]);
    return Response.json({
      libraryItems: { used: libraryItemCount, limit: resolveMaxLibraryItemsPerAccount(env) },
      libraryBytes: { used: libraryByteTotal, limit: resolveMaxLibraryBytesPerAccount(env) },
      devices: { used: deviceCount, limit: resolveMaxDevicesPerAccount(env) },
      sessions: { used: sessionCount, limit: resolveMaxActiveSessionsPerAccount(env) },
      passkeys: { used: credentials.length, limit: resolveMaxPasskeysPerAccount(env) },
    });
  });

  // --- 登録モード仕様 Phase1 §5.6: passkey management ---

  router.get("/api/me/passkeys", async (request, env) => {
    const account = await requireAccount(request, env);
    const credentials = await listCredentialsForAccount(env.APP_DB, account.id);
    return Response.json({ passkeys: credentials.map(passkeyDto) });
  });

  router.delete("/api/me/passkeys/:passkeyId", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    const credentials = await listCredentialsForAccount(env.APP_DB, account.id);
    if (credentials.length <= 1) {
      // Never leave an account with zero ways to sign in (登録モード仕様
      // Phase1 §5.6 "最後の1本は削除不可").
      throw Errors.conflict("LAST_PASSKEY", "cannot delete your only passkey");
    }
    const deleted = await deleteCredentialById(env.APP_DB, account.id, params.passkeyId);
    if (!deleted) {
      throw Errors.notFound("PASSKEY_NOT_FOUND", "passkey not found");
    }
    logAuditEvent("passkey.deleted", { accountId: account.id, passkeyId: params.passkeyId });
    return new Response(null, { status: 204 });
  });

  // --- 登録モード仕様 Phase1 §5.5: account deletion ---

  router.delete("/api/me/account", async (request, env) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    // アカウント削除: 5/日/account, fail-closed (登録モード仕様 Phase1 §5.7/
    // §8d) — checked before the confirmation-body validation so a repeated
    // wrong-confirmation submission also counts against the budget.
    const limited = await enforcePurposeRateLimit(request, env, {
      purpose: "account.deletion",
      limit: ACCOUNT_DELETION_LIMIT,
      failClosed: true,
      extraKey: account.id,
      windowMs: ACCOUNT_DELETION_WINDOW_MS,
    });
    if (limited !== null) {
      return limited;
    }
    const body = await readJsonBody(request);
    const { confirmation } = body;
    if (confirmation !== "DELETE") {
      throw Errors.badRequest("CONFIRMATION_REQUIRED", 'confirmation must be the literal string "DELETE"');
    }

    await deleteAccountCompletely(env, account);
    logAuditEvent("account.deleted", { accountId: account.id });

    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": buildExpiredSessionCookie() },
    });
  });
}
