// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import {
  createOrReplaceOpdsConnection,
  deleteOpdsConnectionForAccount,
  fetchOpdsCatalogPage,
  listOpdsConnections,
  startOpdsImport,
} from "./service";
import { verifyCsrf, verifySecFetchSite } from "../../auth/csrf";
import type { Account } from "../../auth/sessions";
import { requireSession } from "../../auth/sessions";
import { resolveOpdsImportMode } from "../../feature-flags";
import { enforceRateLimit, enforcePurposeRateLimit } from "../../ratelimiter";
import type { Router } from "../../router";
import { Errors } from "../../security/errors";
import type { Env } from "../../types";

/**
 * HTTP adapter for the generic OPDS integration (spec §12/§13). Named
 * `registerOpdsIntegrationRoutes` — NOT `registerOpdsRoutes`, which
 * src/opds/routes.ts already exports for the existing device-facing "serve
 * html2xtc's own library as OPDS" feature (spec §28's namespace-collision
 * warning). Every route here requires a Cookie session (spec §2.2); the
 * mutating ones additionally require CSRF (src/auth/csrf.ts), matching
 * src/library/routes.ts's requireAccount/requireCsrf pattern — NOT the
 * spec text's `X-CSRF-Token` header, which does not exist in this codebase.
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

/**
 * Sec-Fetch-Site-only guard for the catalog GET (spec §21/§24.6 review): this
 * GET has no state-changing body, so a full requireCsrf (Origin +
 * Content-Type) would be the wrong shape — but it DOES have a side effect (an
 * outbound, credentialed fetch to the connection's external OPDS server) that
 * a cross-site page could otherwise trigger for free to burn the account's
 * opds.catalog.fetch rate-limit budget and force upstream traffic. Rejecting
 * an explicit cross-site Sec-Fetch-Site (while still allowing a missing
 * header, for older clients/tools) closes that without touching the
 * GET's cacheability/idempotence semantics.
 */
function requireSecFetchSite(request: Request): void {
  const result = verifySecFetchSite(request);
  if (!result.ok) {
    throw Errors.forbidden("CSRF_REJECTED", result.reason);
  }
}

const MAX_SEARCH_QUERY_CHARS = 256;

/** Spec §20: "OPDS APIは503または既存方針に合わせたエラー" when OPDS_IMPORT_MODE is disabled. Checked before rate limiting so a disabled deployment never burns a rate-limit budget on requests it rejects outright anyway (same ordering as PAIRING_MODE in src/devices/routes.ts). */
function requireOpdsImportEnabled(env: Env): void {
  if (resolveOpdsImportMode(env) !== "enabled") {
    throw Errors.serviceUnavailable("OPDS_IMPORT_DISABLED", "OPDS import is currently disabled");
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

// spec §21's per-purpose rate-limit table.
const CONNECTION_VERIFY_LIMIT = 10;
const CATALOG_FETCH_LIMIT = 120;
const IMPORT_START_LIMIT = 30;

export function registerOpdsIntegrationRoutes(router: Router): void {
  router.get("/api/integrations/opds", async (request, env) => {
    const account = await requireAccount(request, env);
    requireOpdsImportEnabled(env);
    const connections = await listOpdsConnections(env, account.id);
    return Response.json(
      { connections },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });

  router.post("/api/integrations/opds", async (request, env) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    requireOpdsImportEnabled(env);
    // opds.connection.verify: 10/h, IP+accountId, fail-closed (spec §21) —
    // checked before the (cheap) body validation so a repeated malformed
    // submission also counts against the budget, matching the account-
    // deletion rate-limit convention in src/auth/routes.ts.
    const limited = await enforcePurposeRateLimit(request, env, {
      purpose: "opds.connection.verify",
      limit: CONNECTION_VERIFY_LIMIT,
      extraKey: account.id,
      failClosed: true,
    });
    if (limited !== null) {
      return limited;
    }
    const body = await readJsonBody(request);
    const { connection } = await createOrReplaceOpdsConnection(env, account.id, body);
    return Response.json({ connection }, { status: 201 });
  });

  router.delete("/api/integrations/opds/:connectionId", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    requireOpdsImportEnabled(env);
    await deleteOpdsConnectionForAccount(env, account.id, params.connectionId as string);
    return new Response(null, { status: 204 });
  });

  router.get("/api/integrations/opds/:connectionId/catalog", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireSecFetchSite(request);
    requireOpdsImportEnabled(env);
    // opds.catalog.fetch: 120/h per account (no IP component — a mobile
    // client legitimately changes IP mid-session), fail-closed (spec §21).
    const limited = await enforcePurposeRateLimit(request, env, {
      purpose: "opds.catalog.fetch",
      limit: CATALOG_FETCH_LIMIT,
      extraKey: account.id,
      scope: "account",
      failClosed: true,
    });
    if (limited !== null) {
      return limited;
    }
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const search = url.searchParams.get("search");
    if (search !== null && search.length > MAX_SEARCH_QUERY_CHARS) {
      throw Errors.badRequest("OPDS_SEARCH_QUERY_TOO_LONG", `search must be at most ${MAX_SEARCH_QUERY_CHARS} characters`);
    }
    const page = await fetchOpdsCatalogPage(env, account.id, params.connectionId as string, {
      ...(cursor !== null ? { cursor } : {}),
      ...(search !== null ? { search } : {}),
    });
    return Response.json(page, { headers: { "Cache-Control": "private, no-store" } });
  });

  router.post("/api/integrations/opds/:connectionId/import", async (request, env, params) => {
    const account = await requireAccount(request, env);
    requireCsrf(request, env);
    requireOpdsImportEnabled(env);
    // opds.import.start: 30/h, IP+accountId, fail-closed (spec §21) — PLUS
    // the existing conversion-start limiter (spec §21 "importは既存の変換
    // 開始制限も通す"), same as every other job-creating endpoint.
    const limited = await enforcePurposeRateLimit(request, env, {
      purpose: "opds.import.start",
      limit: IMPORT_START_LIMIT,
      extraKey: account.id,
      failClosed: true,
    });
    if (limited !== null) {
      return limited;
    }
    const generalLimited = await enforceRateLimit(request, env);
    if (generalLimited !== null) {
      return generalLimited;
    }
    const body = await readJsonBody(request);
    const result = await startOpdsImport(env, account.id, params.connectionId as string, {
      acquisitionCursor: body.acquisitionCursor,
      title: body.title,
      epubOptions: body.epubOptions,
    });
    return Response.json(result, { status: 202 });
  });
}
