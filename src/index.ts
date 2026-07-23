// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { registerAuthRoutes } from "./auth/routes";
import {
  clampBookSearchLimit,
  normalizeBookSearchQuery,
  searchBooks,
} from "./catalog-db";
import { convertInContainer } from "./container";
import { cleanupAppDb } from "./db/cleanup";
import { registerDeviceRoutes } from "./devices/routes";
import { decodeEpubOptionsHeader } from "./epub-options";
import {
  decodeEpubFilenameHeader,
  hasEpubZipMagic,
  isAllowedEpubContentType,
  peekLeadingBytes,
  resolveMaxUploadEpubBytes,
  saveUploadedEpub,
} from "./epub-upload";
import { prepareRenderInput } from "./extract";
import { resolveConversionMode } from "./feature-flags";
import { registerInternalRoutes } from "./internal/routes";
import {
  articleHtmlKey,
  decideMissingDownload,
  epubHtmlKey,
  inputEpubKey,
  inputPdfKey,
  inputTextKey,
  intermediatePdfKey,
  mapEpubInstanceStatus,
  mapInstanceStatus,
  mapPdfInstanceStatus,
  mapTextInstanceStatus,
  needsPhaseProbe,
  outputXtcKey,
  resolveMaxPdfBytes,
  xtcContentDisposition,
} from "./jobs";
import { registerLibraryRoutes } from "./library/routes";
import { registerOpdsRoutes } from "./opds/routes";
import { renderPdf, renderPdfFromHtml } from "./pdf";
import { handleTextPreview } from "./preview/text-preview";
import {
  checkContentLength,
  decodeFilenameHeader,
  decodePdfOptionsHeader,
  isAllowedPdfContentType,
  resolveMaxUploadPdfBytes,
  saveUploadedPdf,
} from "./pdf-upload";
import { storeXtcOutput } from "./pipeline";
import { registerPublicConfigRoute } from "./public-config";
import { enforceRateLimit } from "./ratelimiter";
import { Router } from "./router";
import { newRequestId, withSecurityHeaders } from "./security/headers";
import { isAozoraBunkoUrl, resolveRenderOptions } from "./sitepresets";
import {
  decodeTextFilenameHeader,
  isAllowedTextContentType,
  saveUploadedText,
} from "./text-upload";
import { MAX_TEXT_FILE_BYTES } from "./text-normalize";
import { decodeTextOptionsHeader } from "./text-options";
import type { AozoraCatalogSyncParams, ConvertJobParams, ConvertMode, Env } from "./types";
import { UrlValidationError, validatePublicUrl } from "./validate";

export { AozoraCatalogSyncWorkflow } from "./catalog-workflow";
export { XtcConverterContainer } from "./container";
export { RateLimiter } from "./ratelimiter";
export { ConvertWorkflow } from "./workflow";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Sync-path budget for the container fetch. Deliberately short: /convert is
// for short pages; long documents go through /jobs, where the Workflow
// allows the full 600s xtctool run (see src/workflow.ts).
const SYNC_CONVERTER_FETCH_TIMEOUT_MS = 150_000;

// New (Phase 0+) endpoints — auth, library, devices, pairings, OPDS — are
// registered here instead of in route() below. Existing endpoints are never
// moved onto this router; router.handle() returns null for any path it
// doesn't own, and fetch() falls back to the legacy route() unchanged.
const router = new Router();
registerAuthRoutes(router);
registerLibraryRoutes(router);
registerDeviceRoutes(router);
registerOpdsRoutes(router);
registerPublicConfigRoute(router);
registerInternalRoutes(router);

export default {
  async fetch(request, env) {
    // Whatever fails below, the client always gets an {error} JSON.
    try {
      const routed = await router.handle(request, env);
      if (routed !== null) {
        return withSecurityHeaders(routed, newRequestId());
      }
      return await route(request, env);
    } catch (error) {
      console.error("unhandled error", error);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },

  // Daily Cron (see wrangler.jsonc triggers.crons). Kicks off the Aozora
  // catalog sync Workflow and returns; the heavy work (fetch, parse, D1 load)
  // runs in the Workflow, never in this short-lived scheduled invocation.
  // Also runs the Phase 7 (plan §19) APP_DB cleanup (src/db/cleanup.ts) in
  // its own try/catch, so the two jobs can never take each other down: a
  // failed catalog sync still lets cleanup run, and vice versa.
  async scheduled(controller, env) {
    // Deriving the instance ID from scheduledTime dedupes a doubled Cron
    // delivery: a second create() with the same ID throws instead of starting
    // a parallel sync.
    const id = `aozora-${controller.scheduledTime}`;
    const params: AozoraCatalogSyncParams = {
      scheduledTime: controller.scheduledTime,
      cron: controller.cron,
    };
    try {
      await env.AOZORA_SYNC_WORKFLOW.create({
        id,
        params,
        // Instances carry no user data, only catalog metadata; a week is
        // enough to inspect a failed sync's history via the dashboard.
        retention: {
          successRetention: "7 days",
          errorRetention: "7 days",
        },
      });
    } catch (error) {
      // A duplicate-ID error means this scheduledTime already has a run; that
      // is the intended dedupe, not a failure worth escalating.
      console.error(`[${id}] catalog sync workflow create failed`, error);
    }

    try {
      // cleanupAppDb() already catches per-table D1 errors internally and
      // never throws; this catch is defense-in-depth only, so a genuinely
      // unexpected error here (e.g. in cutoff computation) still can't take
      // down the rest of scheduled().
      await cleanupAppDb(env);
    } catch (error) {
      console.error(`[${id}] app-db cleanup failed`, error);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/convert") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const disabled = conversionModeGate(env);
    if (disabled) {
      return disabled;
    }
    // Per-IP limit on the endpoints that start a conversion (this one and
    // POST /jobs below); the cheap GET endpoints stay unlimited.
    const limited = await enforceRateLimit(request, env);
    if (limited) {
      return limited;
    }
    return handleConvert(request, env);
  }

  if (pathname === "/jobs") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const disabled = conversionModeGate(env);
    if (disabled) {
      return disabled;
    }
    const limited = await enforceRateLimit(request, env);
    if (limited) {
      return limited;
    }
    return handleCreateJob(request, env);
  }

  // Must come before the /jobs/:jobId matcher below (its [^/]+ group would
  // otherwise swallow "pdf" as a jobId) — spec §10.1. Unlike /convert and
  // /jobs, the rate limit is NOT applied here: handleCreatePdfJob applies it
  // itself, after its own cheap Content-Type/Content-Length checks (spec
  // §8.1's recommended order: header validation → rate limit → R2 upload).
  if (pathname === "/jobs/pdf") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const disabled = conversionModeGate(env);
    if (disabled) {
      return disabled;
    }
    return handleCreatePdfJob(request, env);
  }

  // Same reasoning as /jobs/pdf above: must come before /jobs/:jobId, and
  // the rate limit is applied inside handleCreateTextJob (after its own
  // cheap Content-Type/Content-Length checks) rather than at dispatch here
  // (text-upload spec §13.1).
  if (pathname === "/jobs/text") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const disabled = conversionModeGate(env);
    if (disabled) {
      return disabled;
    }
    return handleCreateTextJob(request, env);
  }

  // Same reasoning as /jobs/pdf and /jobs/text above: must come before
  // /jobs/:jobId, and the rate limit is applied inside handleCreateEpubJob
  // (after its own cheap Content-Type/Content-Length checks) rather than at
  // dispatch here (EPUB spec §4.1).
  if (pathname === "/jobs/epub") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const disabled = conversionModeGate(env);
    if (disabled) {
      return disabled;
    }
    return handleCreateEpubJob(request, env);
  }

  // Must come before the /jobs/:jobId matcher below, same reasoning as
  // /jobs/pdf and /jobs/text above (this path doesn't collide with that
  // matcher's shape, but keeping every fixed POST endpoint above the dynamic
  // matchers is the established convention here). The rate limit is applied
  // inside handleTextPreview itself (preview spec §9's order: Content-Type
  // -> Content-Length -> rate limit -> JSON parse -> ...), not at dispatch.
  if (pathname === "/preview/text") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    return handleTextPreview(request, env);
  }

  if (pathname === "/api/books") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    // Read-only D1 lookup, no rate limit (like the other GET endpoints): the
    // worst case is ~28ms / 17.8k rows_read, while the heavy POST /jobs path
    // already carries the 50/h limit.
    return handleBookSearch(request, env);
  }

  const jobStatus = pathname.match(/^\/jobs\/([^/]+)$/);
  if (jobStatus) {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return handleJobStatus(jobStatus[1], env);
  }

  const jobDownload = pathname.match(/^\/jobs\/([^/]+)\/download$/);
  if (jobDownload) {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return handleJobDownload(jobDownload[1], env);
  }

  const download = pathname.match(/^\/download\/([^/]+)$/);
  if (download) {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return handleDownload(download[1], env);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * 登録モード仕様 Phase3 §7: CONVERSION_MODE==="disabled" のときだけ新規
 * 変換の開始(/convert, /jobs, /jobs/pdf, /jobs/text)を止める。
 * enforceRateLimit と同じ「Response | null を返す」形にして、各分岐の
 * メソッドチェック直後・レート制限のカウント消費前に呼べるようにする
 * (無効化されている間はレート制限バジェットを消費させない)。ジョブ状態
 * 参照・ダウンロードは対象外(呼び出し箇所なし)。この legacy route() は
 * 新Router(src/router.ts)の {"error":{code,message}} 形ではなく既存の
 * {"error": "<string>"} 形を使う — 同ファイルの他のエラー応答と同じ規約。
 */
function conversionModeGate(env: Env): Response | null {
  if (resolveConversionMode(env) === "disabled") {
    return Response.json({ error: "conversion is currently disabled" }, { status: 503 });
  }
  return null;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { Allow: allow } },
  );
}

// The catalogue updates at most daily, so search responses are safe to cache
// briefly at the edge / in the browser.
const BOOK_SEARCH_CACHE_CONTROL = "public, max-age=300";

/**
 * GET /api/books?q=<query>&limit=<n> — substring search over the active Aozora
 * catalogue generation. q is normalized with normalizeCatalogText; a missing,
 * blank, or punctuation-only q returns 200 {books:[]} without touching D1.
 * limit defaults to 50, capped at 50 (invalid values fall back to the
 * default). Rows without HTML are excluded, so every hit has a non-empty
 * htmlUrl. Responses carry a 5-minute cache.
 */
async function handleBookSearch(
  request: Request,
  env: Env,
): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const query = normalizeBookSearchQuery(searchParams.get("q"));
  if (query === "") {
    return Response.json(
      { books: [] },
      { headers: { "Cache-Control": BOOK_SEARCH_CACHE_CONTROL } },
    );
  }
  const limit = clampBookSearchLimit(searchParams.get("limit"));
  const books = await searchBooks(env.AOZORA_DB, query, limit);
  return Response.json(
    { books },
    { headers: { "Cache-Control": BOOK_SEARCH_CACHE_CONTROL } },
  );
}

interface ConvertRequest {
  target: URL;
  mode: ConvertMode;
  /**
   * Raw optional render options: validated fail-soft later by
   * resolveRenderOptions (invalid values act as unspecified — never a 4xx —
   * so the per-site defaults kick in), unlike mode's strict 400.
   */
  layout?: string;
  font?: string;
}

/**
 * Parses the {url, mode, layout, font} request body and runs SSRF
 * validation. mode is optional and defaults to "full" (the pre-extract
 * behavior); layout/font are optional render options resolved per URL by
 * resolveRenderOptions. Returns the validated request, or the error
 * Response to send as-is.
 */
async function readConvertRequest(
  request: Request,
): Promise<ConvertRequest | Response> {
  let url: unknown;
  let mode: unknown;
  let layout: unknown;
  let font: unknown;
  try {
    ({ url, mode, layout, font } = await request.json<{
      url?: unknown;
      mode?: unknown;
      layout?: unknown;
      font?: unknown;
    }>());
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }
  if (typeof url !== "string" || url.length === 0) {
    return Response.json({ error: "url is required" }, { status: 400 });
  }
  if (mode !== undefined && mode !== "full" && mode !== "extract") {
    return Response.json(
      { error: 'mode must be "full" or "extract"' },
      { status: 400 },
    );
  }

  try {
    return {
      target: await validatePublicUrl(url),
      mode: mode ?? "full",
      ...(typeof layout === "string" ? { layout } : {}),
      ...(typeof font === "string" ? { font } : {}),
    };
  } catch (error) {
    if (error instanceof UrlValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

async function handleCreateJob(request: Request, env: Env): Promise<Response> {
  const parsed = await readConvertRequest(request);
  if (parsed instanceof Response) {
    return parsed;
  }
  const { target, mode, layout, font } = parsed;

  const jobId = crypto.randomUUID();
  try {
    await env.CONVERT_WORKFLOW.create({
      id: jobId,
      params: {
        url: target.toString(),
        mode,
        // Stored raw; the Workflow re-resolves them via resolveRenderOptions
        // (params persist across deploys, so it never trusts the shape).
        ...(layout !== undefined ? { layout } : {}),
        ...(font !== undefined ? { font } : {}),
      },
      // The submitted URL lives in params, so instance state must not outlive
      // the ~24h promised to users (default retention is 30 days on Paid).
      // Errored instances carry the URL too, hence the same errorRetention.
      retention: {
        successRetention: "1 day",
        errorRetention: "1 day",
      },
    });
  } catch (error) {
    // create() throws on duplicate IDs (practically impossible with fresh
    // UUIDs) and on platform errors; both are internal from the client's view.
    console.error(`[${jobId}] workflow create failed`, error);
    return Response.json({ error: "failed to create job" }, { status: 500 });
  }

  return Response.json(
    { jobId, statusUrl: `/jobs/${jobId}` },
    { status: 202 },
  );
}

/**
 * POST /jobs/pdf handler (spec §10.2 order): Content-Type → Content-Length
 * → rate limit → X-File-Name → X-Pdf-Options → jobId → stream request.body
 * into R2 (never request.arrayBuffer(), spec §10.3, via saveUploadedPdf) →
 * create the Workflow → 202. Unlike /convert and /jobs above, the rate
 * limit is applied here (inside the handler) rather than at the route()
 * dispatch, so it runs after the cheap header checks per spec §8.1's
 * recommended order ("最低限のヘッダー検証 → レート制限 → R2アップロード").
 */
async function handleCreatePdfJob(request: Request, env: Env): Promise<Response> {
  if (!isAllowedPdfContentType(request.headers.get("Content-Type"))) {
    return Response.json(
      { error: "Content-Type must be application/pdf or application/x-pdf" },
      { status: 415 },
    );
  }

  const maxUploadBytes = resolveMaxUploadPdfBytes(env);
  const lengthCheck = checkContentLength(request.headers.get("Content-Length"), maxUploadBytes);
  if (lengthCheck.kind === "missing") {
    return Response.json({ error: "Content-Length is required" }, { status: 411 });
  }
  if (lengthCheck.kind === "invalid") {
    return Response.json(
      { error: "Content-Length must be a positive integer" },
      { status: 400 },
    );
  }
  if (lengthCheck.kind === "too-large") {
    return Response.json(
      { error: `uploaded PDF exceeds the ${maxUploadBytes} byte limit` },
      { status: 413 },
    );
  }

  const limited = await enforceRateLimit(request, env);
  if (limited) {
    return limited;
  }

  const filename = decodeFilenameHeader(request.headers.get("X-File-Name"));

  const optionsResult = decodePdfOptionsHeader(request.headers.get("X-Pdf-Options"));
  if (!optionsResult.ok) {
    return Response.json({ error: optionsResult.error }, { status: 400 });
  }
  const pdfOptions = optionsResult.options;

  if (request.body === null) {
    return Response.json({ error: "request body is required" }, { status: 400 });
  }

  const jobId = crypto.randomUUID();
  const key = inputPdfKey(jobId);
  const declaredSize = lengthCheck.length;

  const saveResult = await saveUploadedPdf(env, key, request.body, declaredSize, filename);
  if (!saveResult.ok) {
    return Response.json({ error: saveResult.error }, { status: saveResult.status });
  }

  const params: ConvertJobParams = {
    source: { kind: "pdf", key, filename, size: declaredSize },
    pdfOptions,
  };

  try {
    await env.CONVERT_WORKFLOW.create({
      id: jobId,
      params,
      // Mirrors POST /jobs above: the input PDF is deleted by the Workflow
      // itself well before this window (spec §9.5), but keeping both
      // retentions at the same ~1 day is simplest.
      retention: {
        successRetention: "1 day",
        errorRetention: "1 day",
      },
    });
  } catch (error) {
    console.error(`[${jobId}] workflow create failed`, error);
    await deleteBestEffort(env, key);
    return Response.json({ error: "failed to create job" }, { status: 500 });
  }

  return Response.json({ jobId, statusUrl: `/jobs/${jobId}` }, { status: 202 });
}

/**
 * POST /jobs/text handler (text-upload spec §11/§13.1 order): Content-Type
 * -> Content-Length -> rate limit -> X-File-Name -> X-Text-Options -> jobId
 * -> stream request.body into R2 (never request.arrayBuffer(), spec §13.3,
 * via saveUploadedText) -> create the Workflow -> 202. Mirrors
 * handleCreatePdfJob's structure and its "rate limit after the cheap header
 * checks" ordering.
 */
async function handleCreateTextJob(request: Request, env: Env): Promise<Response> {
  if (!isAllowedTextContentType(request.headers.get("Content-Type"))) {
    return Response.json(
      { error: "Content-Type must be text/plain or application/octet-stream" },
      { status: 415 },
    );
  }

  const lengthCheck = checkContentLength(request.headers.get("Content-Length"), MAX_TEXT_FILE_BYTES);
  if (lengthCheck.kind === "missing") {
    return Response.json({ error: "Content-Length is required" }, { status: 411 });
  }
  if (lengthCheck.kind === "invalid") {
    return Response.json(
      { error: "Content-Length must be a positive integer" },
      { status: 400 },
    );
  }
  if (lengthCheck.kind === "too-large") {
    return Response.json(
      { error: `uploaded text file exceeds the ${MAX_TEXT_FILE_BYTES} byte limit` },
      { status: 413 },
    );
  }

  const limited = await enforceRateLimit(request, env);
  if (limited) {
    return limited;
  }

  const filename = decodeTextFilenameHeader(request.headers.get("X-File-Name"));

  const optionsResult = decodeTextOptionsHeader(request.headers.get("X-Text-Options"));
  if (!optionsResult.ok) {
    return Response.json({ error: optionsResult.error }, { status: 400 });
  }
  const textOptions = optionsResult.options;

  if (request.body === null) {
    return Response.json({ error: "request body is required" }, { status: 400 });
  }

  const jobId = crypto.randomUUID();
  const key = inputTextKey(jobId);
  const declaredSize = lengthCheck.length;

  const saveResult = await saveUploadedText(env, key, request.body, declaredSize, filename);
  if (!saveResult.ok) {
    return Response.json({ error: saveResult.error }, { status: saveResult.status });
  }

  const params: ConvertJobParams = {
    source: { kind: "text", key, filename, size: declaredSize },
    textOptions,
  };

  try {
    await env.CONVERT_WORKFLOW.create({
      id: jobId,
      params,
      retention: {
        successRetention: "1 day",
        errorRetention: "1 day",
      },
    });
  } catch (error) {
    console.error(`[${jobId}] workflow create failed`, error);
    await deleteBestEffort(env, key);
    return Response.json({ error: "failed to create job" }, { status: 500 });
  }

  return Response.json({ jobId, statusUrl: `/jobs/${jobId}` }, { status: 202 });
}

/**
 * POST /jobs/epub handler (EPUB spec §4.1/§7 order). Unlike PDF/TXT, X-File-
 * Name is decoded BEFORE the Content-Type gate: application/octet-stream is
 * only accepted with a ".epub" filename (spec §7.1), so isAllowedEpubContentType
 * needs the decoded filename to make that call. This reordering can't shift
 * any error's precedence — decodeEpubFilenameHeader can never itself produce
 * an error (a missing/undecodable header just degrades to the default
 * filename, same as the PDF/TXT paths). Order: X-File-Name -> Content-Type
 * -> Content-Length -> rate limit -> X-Epub-Options -> jobId -> ZIP magic
 * sniff -> stream request.body into R2 (never request.arrayBuffer(), spec
 * §7.3/§18, via saveUploadedEpub) -> create the Workflow -> 202. Deep EPUB
 * structure validation (container.xml/OPF/spine/encryption/Fixed Layout,
 * src/epub/*) happens in the Workflow's prepare-epub step (Phase 4), not
 * here — this handler only confirms the upload looks like *some* ZIP file.
 */
async function handleCreateEpubJob(request: Request, env: Env): Promise<Response> {
  const filename = decodeEpubFilenameHeader(request.headers.get("X-File-Name"));

  if (!isAllowedEpubContentType(request.headers.get("Content-Type"), filename)) {
    return Response.json(
      {
        error:
          "Content-Type must be application/epub+zip, or application/octet-stream with a .epub filename",
      },
      { status: 415 },
    );
  }

  const maxUploadBytes = resolveMaxUploadEpubBytes(env);
  const lengthCheck = checkContentLength(request.headers.get("Content-Length"), maxUploadBytes);
  if (lengthCheck.kind === "missing") {
    return Response.json({ error: "Content-Length is required" }, { status: 411 });
  }
  if (lengthCheck.kind === "invalid") {
    return Response.json(
      { error: "Content-Length must be a positive integer" },
      { status: 400 },
    );
  }
  if (lengthCheck.kind === "too-large") {
    return Response.json(
      { error: `uploaded EPUB exceeds the ${maxUploadBytes} byte limit` },
      { status: 413 },
    );
  }

  const limited = await enforceRateLimit(request, env);
  if (limited) {
    return limited;
  }

  const optionsResult = decodeEpubOptionsHeader(request.headers.get("X-Epub-Options"));
  if (!optionsResult.ok) {
    return Response.json({ error: optionsResult.error }, { status: 400 });
  }
  const epubOptions = optionsResult.options;

  if (request.body === null) {
    return Response.json({ error: "request body is required" }, { status: 400 });
  }

  const { leading, body } = await peekLeadingBytes(request.body, 4);
  if (!hasEpubZipMagic(leading)) {
    return Response.json({ error: "invalid EPUB file" }, { status: 400 });
  }

  const jobId = crypto.randomUUID();
  const key = inputEpubKey(jobId);
  const declaredSize = lengthCheck.length;

  const saveResult = await saveUploadedEpub(env, key, body, declaredSize, filename);
  if (!saveResult.ok) {
    return Response.json({ error: saveResult.error }, { status: saveResult.status });
  }

  const params: ConvertJobParams = {
    source: { kind: "epub", key, filename, size: declaredSize },
    epubOptions,
  };

  try {
    await env.CONVERT_WORKFLOW.create({
      id: jobId,
      params,
      retention: {
        successRetention: "1 day",
        errorRetention: "1 day",
      },
    });
  } catch (error) {
    console.error(`[${jobId}] workflow create failed`, error);
    await deleteBestEffort(env, key);
    return Response.json({ error: "failed to create job" }, { status: 500 });
  }

  return Response.json({ jobId, statusUrl: `/jobs/${jobId}` }, { status: 202 });
}

async function handleJobStatus(jobId: string, env: Env): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) {
    return Response.json({ error: "jobId must be a UUID" }, { status: 400 });
  }

  let instance: WorkflowInstance;
  try {
    instance = await env.CONVERT_WORKFLOW.get(jobId);
  } catch {
    // Unknown ID or past the Workflows instance retention (set to 1 day at
    // create() — distinct from the 24h R2 artifact lifecycle, whose expiry is
    // surfaced by the download handler / decideMissingDownload). Note: a
    // transient platform error in get() also lands here as 404; pollers will
    // see the real status again on the next request.
    return Response.json({ error: "job not found" }, { status: 404 });
  }

  const status = await instance.status();
  return Response.json(await mapWithPhaseProbe(jobId, status, env));
}

async function handleJobDownload(jobId: string, env: Env): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) {
    return Response.json({ error: "jobId must be a UUID" }, { status: 400 });
  }

  // The artifact in R2 is the source of truth: it may outlive the Workflow
  // instance's retention window, and its absence decides 409 vs 404 below.
  const object = await env.XTC_BUCKET.get(outputXtcKey(jobId));
  if (object !== null) {
    return xtcResponse(object, jobId);
  }

  let instance: WorkflowInstance;
  try {
    instance = await env.CONVERT_WORKFLOW.get(jobId);
  } catch {
    // Unknown/expired instance (or a transient get() failure) with no
    // artifact in R2: nothing to download.
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const status = await instance.status();
  const decision = decideMissingDownload(await mapWithPhaseProbe(jobId, status, env));
  if (decision.kind === "conflict") {
    return Response.json(
      { error: "job not completed", status: decision.status },
      { status: 409 },
    );
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * Maps an instance status to the API body. For the running family this
 * probes R2: first for the uploaded-PDF input (PDF jobs — no rendering
 * phase, see mapPdfInstanceStatus), then for the uploaded-TXT input (TXT
 * jobs — three phases, see mapTextInstanceStatus), then for the uploaded-
 * EPUB input (EPUB jobs — three phases, see mapEpubInstanceStatus,
 * EPUB spec §15), then, only if all three are absent, for the intermediate
 * PDF that tells a URL job's rendering from converting. A PDF/TXT/EPUB job
 * whose input was already deleted (the brief window between the Workflow's
 * delete step and its status turning "complete") falls through to the same
 * intermediate-PDF probe as a URL job; since no PDF exists yet at that point
 * it reports "rendering" for that instant — an accepted, self-correcting
 * edge case (see claudedocs/pdf-upload-investigation.md §5.5, which applies
 * identically here).
 *
 * All five R2 heads (input PDF, input TXT, input EPUB, EPUB HTML,
 * intermediate PDF) — plus the pre-existing article HTML head, still needed
 * for the TXT phase split — are fired concurrently via Promise.all rather
 * than awaited one at a time: the decision logic below still applies them in
 * the same PDF -> TXT -> EPUB -> URL priority order and only *uses* each
 * result when a job of that kind actually needs it, but paying for several
 * sequential R2 round-trips per status poll (see
 * claudedocs/text-upload-investigation.md §1.4) was an avoidable latency
 * cost once none of the probes actually depend on each other's result.
 *
 * This function's TODO from before EPUB existed ("replace this per-key R2
 * fan-out with an explicit job-kind metadata read instead of growing this
 * probe set further") was deliberately not acted on here: EPUB reuses the
 * exact same pattern PDF/TXT already established, so following the TODO now
 * would mean refactoring the URL/PDF/TXT code paths too — out of scope for
 * this feature (spec §22 "既存 URL / PDF / TXT API の互換性を壊さない"). Still
 * worth doing before a 6th input format arrives.
 */
async function mapWithPhaseProbe(
  jobId: string,
  status: InstanceStatus,
  env: Env,
) {
  if (!needsPhaseProbe(status.status)) {
    return mapInstanceStatus(jobId, status, false);
  }
  const [hasInputPdf, hasInputText, hasInputEpub, hasArticle, hasEpubHtml, hasIntermediatePdf] =
    await Promise.all([
      env.XTC_BUCKET.head(inputPdfKey(jobId)).then((object) => object !== null),
      env.XTC_BUCKET.head(inputTextKey(jobId)).then((object) => object !== null),
      env.XTC_BUCKET.head(inputEpubKey(jobId)).then((object) => object !== null),
      env.XTC_BUCKET.head(articleHtmlKey(jobId)).then((object) => object !== null),
      env.XTC_BUCKET.head(epubHtmlKey(jobId)).then((object) => object !== null),
      env.XTC_BUCKET.head(intermediatePdfKey(jobId)).then((object) => object !== null),
    ]);
  if (hasInputPdf) {
    return mapPdfInstanceStatus(jobId, status);
  }
  if (hasInputText) {
    return mapTextInstanceStatus(
      jobId,
      status,
      !hasArticle ? "preparing" : hasIntermediatePdf ? "converting" : "rendering",
    );
  }
  if (hasInputEpub) {
    return mapEpubInstanceStatus(
      jobId,
      status,
      !hasEpubHtml ? "preparing" : hasIntermediatePdf ? "converting" : "rendering",
    );
  }
  return mapInstanceStatus(jobId, status, hasIntermediatePdf);
}

async function handleConvert(request: Request, env: Env): Promise<Response> {
  const parsed = await readConvertRequest(request);
  if (parsed instanceof Response) {
    return parsed;
  }
  const { target, mode, layout, font } = parsed;
  // Explicit layout/font win; blanks (and invalid values, fail-soft) resolve
  // to per-site defaults — Aozora Bunko: vertical + BIZ UDMincho.
  const options = resolveRenderOptions(target, layout, font);

  const jobId = crypto.randomUUID();

  let pdfResponse: Response;
  try {
    // Aozora Bunko URLs take the prepared-HTML path regardless of mode: the
    // dedicated extraction lives behind prepareRenderInput, which for mode
    // "full" degrades back to the plain URL render on any problem.
    if (mode === "extract" || isAozoraBunkoUrl(target)) {
      // prepareRenderInput degrades internally (aozora → fetch → browser →
      // full); only the PDF render itself can still throw here.
      const input = await prepareRenderInput(
        env,
        target,
        jobId,
        undefined,
        undefined,
        mode,
        options,
      );
      pdfResponse =
        input.kind === "html"
          ? await renderPdfFromHtml(env, input.html, input.fontCss, options)
          : await renderPdf(env, input.url, options);
    } else {
      pdfResponse = await renderPdf(env, target.toString(), options);
    }
  } catch (error) {
    console.error(`[${jobId}] Browser Run request failed`, error);
    return Response.json({ error: "PDF generation failed", jobId }, { status: 502 });
  }
  if (!pdfResponse.ok) {
    // Upstream detail goes to logs only, never to the client.
    console.error(
      `[${jobId}] Browser Run returned ${pdfResponse.status}: ${await pdfResponse.text()}`,
    );
    return Response.json({ error: "PDF generation failed", jobId }, { status: 502 });
  }

  const pdfBytes = await pdfResponse.arrayBuffer();
  const maxPdfBytes = resolveMaxPdfBytes(env);
  if (pdfBytes.byteLength > maxPdfBytes) {
    return Response.json(
      {
        error: `rendered PDF exceeds the ${maxPdfBytes} byte limit; try a shorter page or the layout-preserving (full) mode`,
        jobId,
      },
      { status: 422 },
    );
  }

  const pdfKey = intermediatePdfKey(jobId);

  // The R2 put and the container call don't depend on each other: run them
  // concurrently and inspect the outcomes individually.
  const [putResult, convertResult] = await Promise.allSettled([
    env.XTC_BUCKET.put(pdfKey, pdfBytes, {
      httpMetadata: { contentType: "application/pdf" },
    }),
    convertInContainer(env, jobId, pdfBytes, SYNC_CONVERTER_FETCH_TIMEOUT_MS),
  ]);

  if (putResult.status === "rejected") {
    // source.pdf is a diagnostic artifact; the conversion doesn't depend on
    // it, so log and continue.
    console.error(`[${jobId}] R2 put ${pdfKey} failed`, putResult.reason);
  }

  try {
    if (convertResult.status === "rejected") {
      console.error(`[${jobId}] converter fetch failed`, convertResult.reason);
      return Response.json(
        { error: "conversion service unavailable", jobId },
        { status: 502 },
      );
    }

    const converterResponse = convertResult.value;
    if (!converterResponse.ok) {
      console.error(
        `[${jobId}] converter returned ${converterResponse.status}: ${await converterResponse.text()}`,
      );
      // A container 413 means the PDF passed the Worker's own size check but
      // the container still rejected it as oversized; surface it as a size
      // error that matches the up-front 422 above rather than the generic
      // failure.
      if (converterResponse.status === 413) {
        return Response.json(
          {
            error: `rendered PDF exceeds the ${maxPdfBytes} byte limit; try a shorter page or the layout-preserving (full) mode`,
            jobId,
          },
          { status: 422 },
        );
      }
      return Response.json({ error: "XTC conversion failed", jobId }, { status: 422 });
    }

    let title: string | undefined;
    try {
      ({ title } = await storeXtcOutput(env, jobId, converterResponse));
    } catch (error) {
      console.error(`[${jobId}] R2 put output.xtc failed`, error);
      return Response.json({ error: "storage error", jobId }, { status: 500 });
    }

    return Response.json({
      jobId,
      downloadUrl: `/download/${jobId}`,
      ...(title !== undefined ? { title } : {}),
    });
  } finally {
    // The sync path never reads the PDF back (conversion used the in-memory
    // bytes); success or failure, the diagnostic copy has served its purpose.
    await deleteBestEffort(env, pdfKey);
  }
}

async function deleteBestEffort(env: Env, key: string): Promise<void> {
  try {
    await env.XTC_BUCKET.delete(key);
  } catch (error) {
    console.error(`best-effort delete of ${key} failed`, error);
  }
}

async function handleDownload(jobId: string, env: Env): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) {
    return Response.json({ error: "jobId must be a UUID" }, { status: 400 });
  }

  const object = await env.XTC_BUCKET.get(outputXtcKey(jobId));
  if (object === null) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return xtcResponse(object, jobId);
}

function xtcResponse(object: R2ObjectBody, jobId: string): Response {
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      // Named after the page title when one was captured at conversion time;
      // falls back to the jobId for older artifacts and untitled pages.
      "Content-Disposition": xtcContentDisposition(
        object.customMetadata?.title,
        jobId,
      ),
    },
  });
}
