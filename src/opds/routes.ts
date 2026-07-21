// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { resolveWebauthnRpId } from "../auth/webauthn";
import type { AuthenticatedDevice } from "../devices/authentication";
import { authenticateDevice, parseBasicAuthHeader } from "../devices/authentication";
import { touchLastSeenIfStale } from "../devices/last-seen";
import { xtcContentDisposition } from "../jobs";
import { enforcePurposeRateLimit } from "../ratelimiter";
import type { Router } from "../router";
import { logAuditEvent } from "../security/audit";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import { OPDS_PAGE_SIZE, buildOpdsFeedXml, computeFeedUpdated, parsePage, trimPage } from "./feed";
import type { OpdsFeedItem } from "./feed";
import {
  getAssignedLibraryItemForDownload,
  listAssignedLibraryItems,
  searchAssignedLibraryItems,
} from "./repository";
import { buildLikePattern } from "./search";

/**
 * HTTP adapter for the Phase 5 device-facing OPDS + download API (plan §9.5
 * / §10): the root catalog feed, the search feed, and the XTC download
 * endpoint. All three require the same device Basic auth
 * (src/devices/authentication.ts) and none of it overlaps with the
 * Cookie-session routes in src/library/routes.ts / src/devices/routes.ts —
 * this is the *device's* view of its own assigned library, not the
 * account owner's management view.
 */

const OPDS_CONTENT_TYPE = "application/atom+xml;charset=utf-8";

/** plan §13's per-purpose table: "端末認証失敗 | IP＋deviceId | 60回/時", fail-closed. */
const DEVICE_AUTH_FAILURE_LIMIT = 60;

/**
 * Builds the 401 for a failed device authentication (plan §9.5 "すべて端末
 * Basic認証を必須とする" / plan's Basic-auth convention): built directly
 * rather than via Errors.unauthorized()/ApiError so the WWW-Authenticate
 * header can be attached — Router.handle's generic toErrorResponse has no
 * way to add response headers to a thrown ApiError.
 */
function unauthorizedResponse(): Response {
  return Response.json(
    { error: { code: "UNAUTHORIZED", message: "device authentication required" } },
    { status: 401, headers: { "WWW-Authenticate": 'Basic realm="html2xtc"' } },
  );
}

/**
 * Counts this request against the per-(IP, deviceId) device-auth-failure
 * limiter (plan §13) and, if it is now over budget, returns a 429/503 to
 * send instead of the plain 401 — fail-closed, so a limiter outage blocks
 * rather than allows further guessing. deviceId comes from whatever the
 * Basic header *claims*, even though authenticateDevice already rejected
 * it; plan §16's "存在有無を判別しにくくする" is about the 401 body, not
 * this internal counter key, so using the claimed id here to scope the
 * budget per attacker-guessed-id is fine. Falls back to a fixed placeholder
 * key when the header couldn't even be parsed, so a per-IP budget still
 * applies to entirely malformed auth attempts.
 */
async function enforceDeviceAuthFailureLimit(request: Request, env: Env): Promise<Response | null> {
  const parsed = parseBasicAuthHeader(request.headers.get("Authorization"));
  return enforcePurposeRateLimit(request, env, {
    purpose: "device.auth.failed",
    limit: DEVICE_AUTH_FAILURE_LIMIT,
    extraKey: parsed?.deviceId ?? "unknown",
    failClosed: true,
  });
}

/** Authenticates the device, or returns the Response to send when it fails (401, or a rate-limit response once the failure budget is spent). */
async function requireDevice(request: Request, env: Env): Promise<AuthenticatedDevice | Response> {
  const device = await authenticateDevice(request, env);
  if (device !== null) {
    return device;
  }
  const limited = await enforceDeviceAuthFailureLimit(request, env);
  return limited ?? unauthorizedResponse();
}

function toFeedItem(item: { id: string; title: string; author: string | null; updatedAt: string }): OpdsFeedItem {
  return { id: item.id, title: item.title, author: item.author, updatedAt: item.updatedAt };
}

function parsePageOrThrow(request: Request): number {
  const page = parsePage(new URL(request.url).searchParams.get("page"));
  if (page === null) {
    throw Errors.badRequest("INVALID_PAGE", "page must be a positive integer");
  }
  return page;
}

/** After a successful OPDS/download response, refreshes last_seen_at (throttled) — plan §10.4 applies this to both fetch and download success, never to a failed request. */
async function markDeviceSeen(env: Pick<Env, "APP_DB">, device: AuthenticatedDevice, nowIso: string): Promise<void> {
  await touchLastSeenIfStale(env.APP_DB, device, nowIso);
}

export function registerOpdsRoutes(router: Router): void {
  router.get("/opds/v1/catalog.xml", async (request, env) => {
    const device = await requireDevice(request, env);
    if (device instanceof Response) {
      return device;
    }
    const page = parsePageOrThrow(request);
    const offset = (page - 1) * OPDS_PAGE_SIZE;

    const rows = await listAssignedLibraryItems(env.APP_DB, device.deviceId, {
      limit: OPDS_PAGE_SIZE + 1,
      offset,
    });
    const { pageItems, hasNext, hasPrevious } = trimPage(rows, page);

    const origin = `https://${resolveWebauthnRpId(env)}`;
    const nowIso = new Date().toISOString();
    const xml = buildOpdsFeedXml({
      feedId: `urn:html2xtc:device:${device.deviceId}`,
      title: "html2xtc マイライブラリ",
      updated: computeFeedUpdated(pageItems, nowIso),
      links: {
        self: `${origin}/opds/v1/catalog.xml${page > 1 ? `?page=${page}` : ""}`,
        search: `${origin}/opds/v1/search.xml?q={searchTerms}`,
        ...(hasNext ? { next: `${origin}/opds/v1/catalog.xml?page=${page + 1}` } : {}),
        ...(hasPrevious ? { previous: `${origin}/opds/v1/catalog.xml?page=${page - 1}` } : {}),
      },
      items: pageItems.map(toFeedItem),
      downloadBaseUrl: `${origin}/api/device/library-items`,
    });

    await markDeviceSeen(env, device, nowIso);
    logAuditEvent("device.opds.fetched", { accountId: device.accountId, deviceId: device.deviceId, page });

    return new Response(xml, { headers: { "Content-Type": OPDS_CONTENT_TYPE } });
  });

  router.get("/opds/v1/search.xml", async (request, env) => {
    const device = await requireDevice(request, env);
    if (device instanceof Response) {
      return device;
    }
    const page = parsePageOrThrow(request);
    const offset = (page - 1) * OPDS_PAGE_SIZE;
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";

    // A blank/missing q matches nothing, same convention as GET /api/books
    // (src/index.ts's handleBookSearch) — never hits D1 for an empty query.
    const rows =
      q.trim().length === 0
        ? []
        : await searchAssignedLibraryItems(env.APP_DB, device.deviceId, buildLikePattern(q), {
            limit: OPDS_PAGE_SIZE + 1,
            offset,
          });
    const { pageItems, hasNext, hasPrevious } = trimPage(rows, page);

    const origin = `https://${resolveWebauthnRpId(env)}`;
    const nowIso = new Date().toISOString();
    const selfQuery = `q=${encodeURIComponent(q)}`;
    const xml = buildOpdsFeedXml({
      feedId: `urn:html2xtc:device:${device.deviceId}:search`,
      title: "html2xtc 検索結果",
      updated: computeFeedUpdated(pageItems, nowIso),
      links: {
        self: `${origin}/opds/v1/search.xml?${selfQuery}${page > 1 ? `&page=${page}` : ""}`,
        ...(hasNext ? { next: `${origin}/opds/v1/search.xml?${selfQuery}&page=${page + 1}` } : {}),
        ...(hasPrevious ? { previous: `${origin}/opds/v1/search.xml?${selfQuery}&page=${page - 1}` } : {}),
      },
      items: pageItems.map(toFeedItem),
      downloadBaseUrl: `${origin}/api/device/library-items`,
    });

    await markDeviceSeen(env, device, nowIso);
    logAuditEvent("device.opds.fetched", { accountId: device.accountId, deviceId: device.deviceId, page, search: 1 });

    return new Response(xml, { headers: { "Content-Type": OPDS_CONTENT_TYPE } });
  });

  router.get("/api/device/library-items/:itemId/download", async (request, env, params) => {
    const device = await requireDevice(request, env);
    if (device instanceof Response) {
      return device;
    }

    const item = await getAssignedLibraryItemForDownload(env.APP_DB, device.deviceId, params.itemId);
    if (item === null) {
      throw Errors.notFound("ITEM_NOT_FOUND", "library item not found");
    }
    const object = await env.XTC_BUCKET.get(item.r2Key);
    if (object === null) {
      throw Errors.notFound("ITEM_NOT_FOUND", "library item not found");
    }

    const nowIso = new Date().toISOString();
    await markDeviceSeen(env, device, nowIso);
    logAuditEvent("device.download.completed", {
      accountId: device.accountId,
      deviceId: device.deviceId,
      itemId: item.id,
      sizeBytes: object.size,
    });

    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "Content-Disposition": xtcContentDisposition(item.title, item.id),
        ETag: object.httpEtag,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
