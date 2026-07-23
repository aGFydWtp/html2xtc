// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { verifyCsrf } from "../auth/csrf";
import type { Account } from "../auth/sessions";
import { requireSession } from "../auth/sessions";
import { autoAddItemToSoleActiveDevice } from "../devices/service";
import { xtcContentDisposition } from "../jobs";
import type { Router } from "../router";
import { logAuditEvent } from "../security/audit";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import {
  deleteLibrary,
  getLibraryDownload,
  listLibrary,
  saveJobToLibrary,
  updateLibrary,
} from "./service";

/**
 * HTTP adapter for the Phase 1 library API (plan §9.2), registered on the
 * shared Router (src/router.ts). Every route requires a valid session;
 * mutating routes (from-job, PATCH, DELETE) additionally require the CSRF
 * checks (src/auth/csrf.ts) since they run on Cookie auth. All error
 * shapes/status codes are thrown as ApiError and converted by
 * Router.handle — handlers below never build an error Response by hand.
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

export function registerLibraryRoutes(router: Router): void {
  router.post("/api/library/items/from-job", async (request, env) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    const body = await readJsonBody(request);
    const { jobId, title, author } = body;
    if (typeof jobId !== "string") {
      throw Errors.badRequest("INVALID_JOB_ID", "jobId is required");
    }
    if (title !== undefined && typeof title !== "string") {
      throw Errors.badRequest("INVALID_TITLE", "title must be a string");
    }
    if (author !== undefined && typeof author !== "string") {
      throw Errors.badRequest("INVALID_AUTHOR", "author must be a string");
    }
    const result = await saveJobToLibrary(env, account, {
      jobId,
      ...(title !== undefined ? { title } : {}),
      ...(author !== undefined ? { author } : {}),
    });
    // Fires even on the idempotent-replay path (an already-saved jobId) —
    // over-logging a harmless replay is preferable to conditioning this
    // audit event on the created/existing distinction, which is only used
    // below to decide whether to auto-add the item to a sole active device.
    logAuditEvent("library.item.created", { accountId: account.id, itemId: result.item.id });
    if (result.created) {
      // Best-effort, never throws — a failed auto-add must not turn this
      // successful library save into an error response (see
      // src/devices/service.ts's autoAddItemToSoleActiveDevice).
      await autoAddItemToSoleActiveDevice(env, account, result.item.id);
    }
    return Response.json({ item: result.item });
  });

  router.get("/api/library/items", async (request, env) => {
    const account = await requireAccount(request, env);
    const items = await listLibrary(env, account);
    return Response.json({ items });
  });

  router.patch("/api/library/items/:itemId", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    const body = await readJsonBody(request);
    const { title, author } = body;
    if (title !== undefined && typeof title !== "string") {
      throw Errors.badRequest("INVALID_TITLE", "title must be a string");
    }
    if (author !== undefined && author !== null && typeof author !== "string") {
      throw Errors.badRequest("INVALID_AUTHOR", "author must be a string or null");
    }
    const item = await updateLibrary(env, account, params.itemId, {
      ...(title !== undefined ? { title } : {}),
      ...(author !== undefined ? { author } : {}),
    });
    return Response.json({ item });
  });

  router.delete("/api/library/items/:itemId", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    await deleteLibrary(env, account, params.itemId);
    logAuditEvent("library.item.deleted", { accountId: account.id, itemId: params.itemId });
    return new Response(null, { status: 204 });
  });

  router.get("/api/library/items/:itemId/download", async (request, env, params) => {
    const account = await requireAccount(request, env);
    const result = await getLibraryDownload(env, account, params.itemId);
    if (result === null) {
      throw Errors.notFound("ITEM_NOT_FOUND", "library item not found");
    }
    const { object, item } = result;
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "Content-Disposition": xtcContentDisposition(item.title, item.id),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
