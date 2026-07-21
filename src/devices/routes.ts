// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { verifyCsrf } from "../auth/csrf";
import type { Account } from "../auth/sessions";
import { requireSession } from "../auth/sessions";
import { enforcePurposeRateLimit } from "../ratelimiter";
import type { Router } from "../router";
import { logAuditEvent } from "../security/audit";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import {
  approvePairingForAccount,
  completePairingByDevice,
  findPairingByCode,
  parsePairingSecretHeader,
  pollPairing,
  rejectPairingForAccount,
  startPairing,
} from "./pairings";
import {
  getDeviceLibrary,
  listDevices,
  renameDevice,
  replaceDeviceLibrary,
  revokeDevice,
  rotateDeviceToken,
} from "./service";

/**
 * HTTP adapter for the Phase 3 (device management + pairing, plan §9.3/§9.4)
 * and Phase 4 (per-device library, plan §7.2/§9.3) APIs, registered on the
 * shared Router (src/router.ts). Mirrors src/library/routes.ts /
 * src/auth/routes.ts: thin handlers that validate request shape, delegate to
 * src/devices/pairings.ts / src/devices/service.ts, and let ApiError
 * propagate to Router.handle's toErrorResponse.
 *
 * Two distinct trust boundaries share this file:
 *  - /api/device-pairings* — unauthenticated, called by the Xteink device
 *    itself, authenticated only by the pairingSecret it was issued (plan
 *    §9.4 "端末から呼ぶ公開API"). POST (pairing start) is rate-limited
 *    (20/h/IP, fail-closed, plan §13); GET :pairingId (device polling) and
 *    POST :pairingId/complete are not yet — that's still TODO'd for a later
 *    phase.
 *  - everything else — Cookie session (requireAccount), CSRF-checked on
 *    every mutation, exactly like the library and auth routes.
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
 * Shared by the three device-pairings endpoints: extracts the
 * `Authorization: Pairing <secret>` header, throwing the same 401 whether
 * it's missing or malformed (a wrong-but-present secret is rejected later,
 * inside pollPairing/completePairingByDevice, with the same 401) — plan §16
 * "認証失敗のエラーで...判別しにくくする" applied to pairings the same way
 * it's applied to device tokens.
 */
function requirePairingSecret(request: Request): string {
  const secret = parsePairingSecretHeader(request.headers.get("Authorization"));
  if (secret === null) {
    throw Errors.unauthorized("pairing secret required");
  }
  return secret;
}

/** plan §13's per-purpose table. */
const PAIRING_START_LIMIT = 20;
const PAIRING_LOOKUP_LIMIT = 60;

export function registerDeviceRoutes(router: Router): void {
  // --- device-pairings: unauthenticated, called by the Xteink device itself ---

  router.post("/api/device-pairings", async (request, env) => {
    // Pairing start: 20/h/IP, fail-closed (plan §13) — this route is
    // unauthenticated (called by the Xteink device itself), so the limiter
    // is the only defense against a flood of pairing rows.
    const limited = await enforcePurposeRateLimit(request, env, {
      purpose: "device.pairing.start",
      limit: PAIRING_START_LIMIT,
      failClosed: true,
    });
    if (limited !== null) {
      return limited;
    }
    const body = await readJsonBody(request);
    const { requestedName } = body;
    if (requestedName !== undefined && typeof requestedName !== "string") {
      throw Errors.badRequest("INVALID_REQUESTED_NAME", "requestedName must be a string");
    }
    const result = await startPairing(env, requestedName ?? null);
    return Response.json(result, { status: 201 });
  });

  router.get("/api/device-pairings/:pairingId", async (request, env, params) => {
    const secret = requirePairingSecret(request);
    const result = await pollPairing(env, params.pairingId, secret);
    return Response.json(result);
  });

  router.post("/api/device-pairings/:pairingId/complete", async (request, env, params) => {
    const secret = requirePairingSecret(request);
    await completePairingByDevice(env, params.pairingId, secret);
    return Response.json({ status: "completed" });
  });

  // --- pairings: Cookie session, called from the WebUI ---

  router.get("/api/pairings/by-code/:userCode", async (request, env, params) => {
    await requireAccount(request, env);
    // userCode lookup: 60/h/IP, fail-closed (plan §13).
    const limited = await enforcePurposeRateLimit(request, env, {
      purpose: "device.pairing.lookup",
      limit: PAIRING_LOOKUP_LIMIT,
      failClosed: true,
    });
    if (limited !== null) {
      return limited;
    }
    const result = await findPairingByCode(env, params.userCode);
    return Response.json(result);
  });

  router.post("/api/pairings/:pairingId/approve", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    const body = await readJsonBody(request);
    const { name } = body;
    if (typeof name !== "string" || name.length === 0) {
      throw Errors.badRequest("INVALID_DEVICE_NAME", "name is required");
    }
    const device = await approvePairingForAccount(env, account, params.pairingId, name);
    logAuditEvent("device.pairing.approved", {
      accountId: account.id,
      deviceId: device.id,
      pairingId: params.pairingId,
    });
    return Response.json({ device });
  });

  router.post("/api/pairings/:pairingId/reject", async (request, env, params) => {
    await requireAccount(request, env);
    requireCsrf(request, env);
    await rejectPairingForAccount(env, params.pairingId);
    return new Response(null, { status: 204 });
  });

  // --- devices: Cookie session ---

  router.get("/api/devices", async (request, env) => {
    const account = await requireAccount(request, env);
    const devices = await listDevices(env, account);
    return Response.json({ devices });
  });

  router.patch("/api/devices/:deviceId", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    const body = await readJsonBody(request);
    const { name } = body;
    if (typeof name !== "string") {
      throw Errors.badRequest("INVALID_DEVICE_NAME", "name must be a string");
    }
    const device = await renameDevice(env, account, params.deviceId, name);
    return Response.json({ device });
  });

  router.delete("/api/devices/:deviceId", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    await revokeDevice(env, account, params.deviceId);
    logAuditEvent("device.revoked", { accountId: account.id, deviceId: params.deviceId });
    return new Response(null, { status: 204 });
  });

  router.post("/api/devices/:deviceId/token", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    const rotated = await rotateDeviceToken(env, account, params.deviceId);
    return Response.json(rotated);
  });

  // --- Phase 4: per-device library ---

  router.get("/api/devices/:deviceId/library", async (request, env, params) => {
    const account = await requireAccount(request, env);
    const library = await getDeviceLibrary(env, account, params.deviceId);
    return Response.json(library);
  });

  router.put("/api/devices/:deviceId/library", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    const body = await readJsonBody(request);
    const { expectedVersion, itemIds } = body;
    if (typeof expectedVersion !== "number") {
      throw Errors.badRequest("INVALID_VERSION", "expectedVersion is required");
    }
    if (!Array.isArray(itemIds)) {
      throw Errors.badRequest("INVALID_ITEM_IDS", "itemIds is required");
    }
    const library = await replaceDeviceLibrary(env, account, params.deviceId, {
      expectedVersion,
      itemIds: itemIds as string[],
    });
    logAuditEvent("device.library.updated", {
      accountId: account.id,
      deviceId: params.deviceId,
      version: library.version,
      itemCount: library.items.length,
    });
    return Response.json(library);
  });
}
