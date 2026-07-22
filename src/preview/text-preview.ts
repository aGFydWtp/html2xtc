// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * POST /preview/text: a synchronous "convert the first ~2,500-4,000 code
 * points of a TXT body to XTC and return the bytes directly" endpoint (see
 * claudedocs/preview-text-investigation.md and
 * /Users/haruki/Downloads/html2xtc-text-preview-endpoint-spec.md).
 *
 * The whole point of this endpoint is to reuse the production TXT pipeline
 * (src/text-prepare.ts's prepareTextDocument — shared verbatim with
 * src/workflow.ts's prepare-text step, spec §14.1 — src/fonts.ts's
 * buildInlineFontCss, src/pdf.ts's renderSelfStyledHtmlPdf, src/container.ts's
 * convertInContainer) rather than reimplement a "preview" typesetting path —
 * so the first pages a user sees here should pixel-match what POST /jobs/text
 * would eventually produce for the same input+options (spec §19), for both
 * `plain` and `aozora` inputFormat alike.
 *
 * Nothing here ever touches R2: the request body, generated HTML, font CSS,
 * PDF and XTC all stay in Worker/Container memory for the duration of one
 * request (spec §4.4/§17/§21).
 */

import { convertInContainer } from "../container";
import { buildInlineFontCss } from "../fonts";
import { resolveMaxPdfBytes } from "../jobs";
import { renderSelfStyledHtmlPdf } from "../pdf";
import { resolveTextPreviewRateLimitPerHour } from "../ratelimit";
import { enforcePurposeRateLimit } from "../ratelimiter";
import { validateTextConvertOptions } from "../text-options";
import type { TextConvertOptions } from "../text-options";
import { prepareTextDocument } from "../text-prepare";
import type { Env } from "../types";
import { AozoraAstLimitExceededError } from "../../packages/aozora-text/src/index";

// --- Limits (spec §5.3/§6.2, §27's recommendation) -------------------------

/** Server-side re-validation ceiling; the client is expected to have already
 * trimmed to this via frontend/src/lib/text-preview.ts's selectTextPreview,
 * but that extraction is never trusted (spec §5.3). */
export const MAX_TEXT_PREVIEW_CODE_POINTS = 4_000;
export const MAX_TEXT_PREVIEW_UTF8_BYTES = 32 * 1024;
export const MAX_TEXT_PREVIEW_REQUEST_BYTES = 64 * 1024;

/** Overall sync budget for this handler (render + convert). */
export const TEXT_PREVIEW_TIMEOUT_MS = 120_000;
/** Passed to convertInContainer as its timeoutMs (spec §15/§27). */
export const TEXT_PREVIEW_CONTAINER_TIMEOUT_MS = 90_000;

const TEXT_PREVIEW_RATE_LIMIT_PURPOSE = "preview-text";

// --- Error shape (spec §20) --------------------------------------------------

/**
 * Stable machine-readable error codes returned in every non-2xx body's
 * `code` field. INTERNAL_ERROR is an addition beyond spec §20's literal
 * list — that section enumerates the condition-specific codes, but §6.1's
 * status table also has a generic 500 row with no code of its own; every
 * error response needs *some* code, so this fills that gap.
 */
export type TextPreviewErrorCode =
  | "INVALID_REQUEST"
  | "TEXT_TOO_LONG"
  | "EMPTY_TEXT"
  | "INVALID_OPTIONS"
  | "FONT_FETCH_FAILED"
  | "PDF_GENERATION_FAILED"
  | "PDF_TOO_LARGE"
  | "CONTAINER_UNAVAILABLE"
  | "XTC_CONVERSION_FAILED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

/** Builds the flat {error, code} response body (spec §6.1) — never the
 * new Router's {error:{code,message}} shape. */
export function jsonError(
  status: number,
  code: TextPreviewErrorCode,
  message: string,
  extraHeaders?: HeadersInit,
): Response {
  return Response.json(
    { error: message, code },
    { status, headers: extraHeaders },
  );
}

// --- Small request-parsing helpers (none of these exist elsewhere; see -----
//     claudedocs/preview-text-investigation.md §9) ---------------------------

const ALLOWED_JSON_CONTENT_TYPES = new Set(["application/json"]);

/** Content-Type check, same shape as pdf-upload.ts's isAllowedPdfContentType:
 * exact media-type match, parameters (e.g. charset) ignored. */
export function isJsonContentType(headerValue: string | null): boolean {
  if (headerValue === null) {
    return false;
  }
  const mediaType = headerValue.split(";")[0]?.trim().toLowerCase();
  return mediaType !== undefined && ALLOWED_JSON_CONTENT_TYPES.has(mediaType);
}

/**
 * Parses Content-Length loosely: a missing or unparsable header returns
 * null ("unspecified" — the caller reads the body and re-checks its real
 * size instead of rejecting outright), unlike pdf-upload.ts's
 * checkContentLength, which treats a missing header as a hard error. Spec
 * §6.2 explicitly wants the lenient behavior here.
 */
export function parseOptionalContentLength(headerValue: string | null): number | null {
  if (headerValue === null) {
    return null;
  }
  if (!/^\d+$/.test(headerValue)) {
    return null;
  }
  const length = Number(headerValue);
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

export type ReadLimitedJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "too-large" }
  | { ok: false; kind: "invalid-json" };

/**
 * Reads the request body while enforcing maxBytes as it streams (rather
 * than buffering an unbounded body and checking after the fact), then
 * JSON-parses it. Returns a discriminated result instead of throwing so
 * callers can map "too-large" to 413 and "invalid-json" to 400.
 */
export async function readLimitedJson<T>(
  request: Request,
  maxBytes: number,
): Promise<ReadLimitedJsonResult<T>> {
  const body = request.body;
  if (body === null) {
    return { ok: false, kind: "invalid-json" };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      return { ok: false, kind: "invalid-json" };
    }
    if (step.done) {
      break;
    }
    total += step.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, kind: "too-large" };
    }
    chunks.push(step.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8").decode(combined);
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, kind: "invalid-json" };
  }
}

// --- Request validation (spec §9) -------------------------------------------

interface TextPreviewRequestBody {
  text?: unknown;
  options?: unknown;
}

/** Length in code points, not UTF-16 units (surrogate-pair safe) — same
 * definition as src/text-normalize.ts's private codePointLength. */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

export type TextPreviewValidationResult =
  | { ok: true; text: string; options: TextConvertOptions }
  | { ok: false; status: number; code: TextPreviewErrorCode; error: string };

/**
 * Validates the parsed JSON body against spec §9 steps 6-8: text type/size,
 * then options via the existing (production) validateTextConvertOptions.
 * showPageNumbers is force-set to false afterward regardless of what was
 * submitted (spec §9/§27 — the validator itself doesn't do this).
 */
export function validateTextPreviewRequest(
  body: unknown,
): TextPreviewValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_REQUEST",
      error: "request body must be a JSON object",
    };
  }
  const v = body as TextPreviewRequestBody;

  if (typeof v.text !== "string") {
    return {
      ok: false,
      status: 400,
      code: "INVALID_REQUEST",
      error: "text is required",
    };
  }
  const text = v.text;

  const codePoints = codePointLength(text);
  if (codePoints > MAX_TEXT_PREVIEW_CODE_POINTS) {
    return {
      ok: false,
      status: 413,
      code: "TEXT_TOO_LONG",
      error: `preview text exceeds the ${MAX_TEXT_PREVIEW_CODE_POINTS} code point limit`,
    };
  }
  const utf8Bytes = new TextEncoder().encode(text).byteLength;
  if (utf8Bytes > MAX_TEXT_PREVIEW_UTF8_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "TEXT_TOO_LONG",
      error: `preview text exceeds the ${MAX_TEXT_PREVIEW_UTF8_BYTES} byte limit`,
    };
  }

  const optionsResult = validateTextConvertOptions(v.options);
  if (!optionsResult.ok) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_OPTIONS",
      error: optionsResult.error,
    };
  }

  // Preview always forces page numbers off (spec §9/§27): a numbered
  // preview page would show a number relative to the truncated preview
  // body, not the eventual full document, which is actively misleading.
  const options: TextConvertOptions = {
    ...optionsResult.options,
    showPageNumbers: false,
  };

  return { ok: true, text, options };
}

// --- Sync HTML -> XTC conversion (spec §13) ---------------------------------

/** Thrown by convertHtmlToXtcSync for every failure that maps to a specific
 * HTTP status/code (spec §20); handleTextPreview below catches this and
 * turns it straight into a Response via jsonError. */
export class SyncConversionError extends Error {
  readonly status: number;
  readonly code: TextPreviewErrorCode;

  constructor(status: number, code: TextPreviewErrorCode, message: string) {
    super(message);
    this.name = "SyncConversionError";
    this.status = status;
    this.code = code;
  }
}

export interface ConvertHtmlToXtcSyncInput {
  jobId: string;
  html: string;
  fontCss: string | null;
  /** Forwarded to convertInContainer as its timeoutMs. */
  timeoutMs: number;
}

export interface SyncXtcResult {
  xtcBytes: ArrayBuffer;
  /** null when the response was too short or didn't look like a v1.0 XTC
   * container — the page-count header is then simply omitted (fail-soft,
   * never a 5xx over a cosmetic header). */
  pageCount: number | null;
}

// XTC container header layout (frontend/src/lib/xtc.ts's parseXtc, kept in
// sync deliberately): magic Uint32LE at offset 0, version Uint16LE at 4,
// pageCount Uint16LE at 6. Reading just these 8 bytes lets the Worker derive
// X-Xtc-Page-Count without any change to converter/app.py (investigation
// report §0/§5: the Container computes page_count internally but never
// sends it as a header).
const XTC_MAGIC = 0x00435458;
const XTC_VERSION = 0x0100;
const XTC_HEADER_MIN_BYTES = 8;

function readXtcPageCount(xtcBytes: ArrayBuffer): number | null {
  if (xtcBytes.byteLength < XTC_HEADER_MIN_BYTES) {
    return null;
  }
  const dv = new DataView(xtcBytes);
  if (dv.getUint32(0, true) !== XTC_MAGIC) {
    return null;
  }
  if (dv.getUint16(4, true) !== XTC_VERSION) {
    return null;
  }
  return dv.getUint16(6, true);
}

/**
 * Renders the article HTML to PDF (renderSelfStyledHtmlPdf — deliberately
 * NOT renderPdfFromHtml, see that function's doc comment) and converts the
 * PDF to XTC via the same trusted Container endpoint /convert uses
 * (convertInContainer). Never touches R2 — this is the piece of
 * handleConvert (src/index.ts) that is safe to reuse for a preview, minus
 * the R2 put calls (spec §4.4/§13/§17), plus a small XTC-page-count read.
 *
 * The XTC response is buffered in full (arrayBuffer()), not streamed
 * through: a preview XTC is at most a handful of 528x792 1-bit pages (a few
 * hundred KB), and buffering is what lets X-Xtc-Page-Count and a definite
 * Content-Length be computed reliably before the response headers are sent
 * — a half-streamed response can't be un-sent if the page-count read turned
 * out to need more bytes than were already flushed.
 */
export async function convertHtmlToXtcSync(
  env: Env,
  input: ConvertHtmlToXtcSyncInput,
): Promise<SyncXtcResult> {
  let pdfResponse: Response;
  try {
    pdfResponse = await renderSelfStyledHtmlPdf(env, input.html, input.fontCss);
  } catch (error) {
    console.error(`[${input.jobId}] preview: Browser Run request failed`, error);
    throw new SyncConversionError(502, "PDF_GENERATION_FAILED", "PDF generation failed");
  }
  if (!pdfResponse.ok) {
    console.error(
      `[${input.jobId}] preview: Browser Run returned ${pdfResponse.status}: ${await pdfResponse.text()}`,
    );
    throw new SyncConversionError(502, "PDF_GENERATION_FAILED", "PDF generation failed");
  }

  const pdfBytes = await pdfResponse.arrayBuffer();
  const maxPdfBytes = resolveMaxPdfBytes(env);
  if (pdfBytes.byteLength > maxPdfBytes) {
    throw new SyncConversionError(
      422,
      "PDF_TOO_LARGE",
      `rendered PDF exceeds the ${maxPdfBytes} byte limit`,
    );
  }

  let converterResponse: Response;
  try {
    converterResponse = await convertInContainer(env, input.jobId, pdfBytes, input.timeoutMs);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new SyncConversionError(504, "TIMEOUT", "XTC conversion timed out");
    }
    console.error(`[${input.jobId}] preview: converter fetch failed`, error);
    throw new SyncConversionError(502, "CONTAINER_UNAVAILABLE", "conversion service unavailable");
  }

  if (!converterResponse.ok) {
    const bodyText = await converterResponse.text().catch(() => "");
    console.error(
      `[${input.jobId}] preview: converter returned ${converterResponse.status}: ${bodyText}`,
    );
    if (converterResponse.status === 413) {
      throw new SyncConversionError(
        422,
        "PDF_TOO_LARGE",
        `rendered PDF exceeds the ${maxPdfBytes} byte limit`,
      );
    }
    throw new SyncConversionError(502, "XTC_CONVERSION_FAILED", "XTC conversion failed");
  }

  const xtcBytes = await converterResponse.arrayBuffer();
  return { xtcBytes, pageCount: readXtcPageCount(xtcBytes) };
}

// --- Overall timeout wrapper (spec §15) -------------------------------------

class PreviewTimeoutError extends Error {}

/** Bounds `work` to `ms`: on expiry the caller gets a rejection immediately
 * (mapped to 504 below), even though `work` itself has no cooperative
 * cancellation and may keep running in the background — acceptable here
 * since Browser Run / the Container each carry their own internal budgets
 * (PDF_OPTIONS.timeout, convertInContainer's AbortSignal.timeout) that will
 * eventually stop it regardless. */
async function withOverallTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PreviewTimeoutError("sync preview timed out")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // Swallow a late rejection from the losing side of the race (e.g. `work`
    // failing after the timeout already won) — it has nowhere useful to go
    // once the response for this request has already been decided.
    work.catch(() => {});
  }
}

// --- Rate limit error reshaping ---------------------------------------------

/**
 * enforcePurposeRateLimit (src/ratelimiter.ts) returns the new Router's
 * {error:{code,message}} body shape; this endpoint's error contract is the
 * flat {error, code} shape (spec §6.1). Since this call site always passes
 * failClosed:false, the only non-null Response it can return is the 429 —
 * never the failClosed 503 — so the status/code here are fixed rather than
 * re-parsed from the original body.
 */
function flattenRateLimitResponse(response: Response): Response {
  const retryAfter = response.headers.get("Retry-After");
  return jsonError(
    429,
    "RATE_LIMITED",
    "rate limit exceeded; try again later",
    retryAfter !== null ? { "Retry-After": retryAfter } : undefined,
  );
}

// --- Handler (spec §14) -----------------------------------------------------

const PREVIEW_XTC_FILENAME = 'inline; filename="preview.xtc"';

/**
 * POST /preview/text. Validation order follows spec §9: Content-Type ->
 * Content-Length cap -> rate limit -> JSON parse -> text/options validation
 * -> normalize -> empty check -> HTML build -> font CSS -> render+convert.
 */
export async function handleTextPreview(request: Request, env: Env): Promise<Response> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return jsonError(415, "INVALID_REQUEST", "Content-Type must be application/json");
  }

  const declaredLength = parseOptionalContentLength(request.headers.get("Content-Length"));
  if (declaredLength !== null && declaredLength > MAX_TEXT_PREVIEW_REQUEST_BYTES) {
    return jsonError(
      413,
      "TEXT_TOO_LONG",
      `preview request exceeds the ${MAX_TEXT_PREVIEW_REQUEST_BYTES} byte limit`,
    );
  }

  const limited = await enforcePurposeRateLimit(request, env, {
    purpose: TEXT_PREVIEW_RATE_LIMIT_PURPOSE,
    limit: resolveTextPreviewRateLimitPerHour(env),
    // Matches /convert's availability-over-strictness stance: a RateLimiter
    // DO hiccup must not take the preview endpoint down.
    failClosed: false,
  });
  if (limited) {
    return flattenRateLimitResponse(limited);
  }

  const parsedBody = await readLimitedJson<TextPreviewRequestBody>(
    request,
    MAX_TEXT_PREVIEW_REQUEST_BYTES,
  );
  if (!parsedBody.ok) {
    if (parsedBody.kind === "too-large") {
      return jsonError(
        413,
        "TEXT_TOO_LONG",
        `preview request exceeds the ${MAX_TEXT_PREVIEW_REQUEST_BYTES} byte limit`,
      );
    }
    return jsonError(400, "INVALID_REQUEST", "request body must be JSON");
  }

  const parsed = validateTextPreviewRequest(parsedBody.value);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.code, parsed.error);
  }

  const jobId = crypto.randomUUID();

  // Same shared preparation entrypoint the production pipeline uses
  // (src/workflow.ts's prepare-text step, spec §14.1's "production and
  // preview must run the same preparation") — no filename for a preview
  // (spec: the request carries text, not a file), so prepareTextDocument's
  // title fallback lands on options.title or "Untitled", same priority order
  // production TXT jobs use.
  let prepared: ReturnType<typeof prepareTextDocument>;
  try {
    prepared = prepareTextDocument({ decodedText: parsed.text, filename: "", options: parsed.options });
  } catch (error) {
    if (error instanceof AozoraAstLimitExceededError) {
      // Deterministic for this exact (already size-capped) preview body —
      // fail-soft per spec §17/§4.3: a content-free, condition-specific
      // error, never an uncaught 500 and never any document content in the
      // response (AozoraAstLimitExceededError's own message holds none).
      return jsonError(
        413,
        "TEXT_TOO_LONG",
        "preview text exceeds the supported document complexity limit",
      );
    }
    console.error(`[${jobId}] preview text: prepare failed`, error);
    return jsonError(500, "INTERNAL_ERROR", "internal error");
  }

  if (!/\S/.test(prepared.searchableText)) {
    return jsonError(422, "EMPTY_TEXT", "preview text is empty after normalization");
  }

  // Same font-subset construction as the production pipeline
  // (src/workflow.ts's runTextSource): title + author + body, so a
  // title/author using characters absent from the body still gets a
  // matching inlined glyph (spec §12).
  const fontSubsetText = `${prepared.documentTitle}\n${parsed.options.title}\n${parsed.options.author}\n${prepared.searchableText}`;
  const fontCss = await buildInlineFontCss(fontSubsetText, jobId, fetch, parsed.options.font);
  const fontFallback = fontCss === null;

  let result: SyncXtcResult;
  try {
    result = await withOverallTimeout(
      convertHtmlToXtcSync(env, {
        jobId,
        html: prepared.html,
        fontCss,
        timeoutMs: TEXT_PREVIEW_CONTAINER_TIMEOUT_MS,
      }),
      TEXT_PREVIEW_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof PreviewTimeoutError) {
      return jsonError(504, "TIMEOUT", "preview generation timed out");
    }
    if (error instanceof SyncConversionError) {
      return jsonError(error.status, error.code, error.message);
    }
    console.error(`[${jobId}] preview text: unexpected error`, error);
    return jsonError(500, "INTERNAL_ERROR", "internal error");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": PREVIEW_XTC_FILENAME,
    "Content-Length": String(result.xtcBytes.byteLength),
    // No caching or persistence of any kind (spec §4.4/§17/§21): this
    // response is never a candidate for a shared or browser cache.
    "Cache-Control": "no-store, private",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Preview-Character-Count": String(prepared.characterCount),
  };
  if (result.pageCount !== null) {
    headers["X-Xtc-Page-Count"] = String(result.pageCount);
  }
  if (fontFallback) {
    headers["X-Preview-Font-Fallback"] = "true";
  }

  return new Response(result.xtcBytes, { status: 200, headers });
}
