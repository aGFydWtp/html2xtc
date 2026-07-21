// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { enforcePurposeRateLimit, enforceRateLimit } from "../ratelimiter";
import type { Router } from "../router";
import { logAuditEvent } from "../security/audit";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import { verifyCsrf } from "./csrf";
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
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

/**
 * Best-effort per-IP throttle shared with /convert and /jobs
 * (src/ratelimiter.ts) — not the per-purpose quotas in plan §13, but a real
 * limit is better than none while that phase-7 work is pending. Fails open
 * on a limiter outage, same as the existing call sites. Returns the 429
 * Response (with its Retry-After header) to send as-is, or null to
 * continue — callers must `return` a non-null result directly rather than
 * rethrow, so the 429 status and Retry-After survive.
 */
async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  return enforceRateLimit(request, env);
}

function accountDto(account: Account): { id: string; displayName: string } {
  return { id: account.id, displayName: account.displayName };
}

/** plan §13's per-purpose table. */
const REGISTRATION_START_LIMIT = 10;
const LOGIN_START_LIMIT = 30;
const LOGIN_VERIFY_FAILED_LIMIT = 30;

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
    const options = await startRegistration(env, { invite: { inviteToken, displayName } });
    return Response.json({ options });
  });

  router.post("/api/auth/registration/verify", async (request, env) => {
    const limited = await rateLimited(request, env);
    if (limited !== null) {
      return limited;
    }
    const body = await readJsonBody(request);
    const { response } = body;
    if (typeof response !== "object" || response === null) {
      throw Errors.badRequest("INVALID_RESPONSE", "response is required");
    }
    const userAgent = request.headers.get("User-Agent");
    const result = await finishRegistration(
      env,
      response as RegistrationResponseJSON,
      userAgent,
    );
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
}
