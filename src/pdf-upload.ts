// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { decodeBase64Url } from "./base64url";
import { validatePageRangeSyntax } from "./pdf-page-range";
import type { Env, PdfConvertOptions } from "./types";

/**
 * POST /jobs/pdf support (spec §8.1/§10.2): header validation, PdfConvertOptions
 * schema validation, and the streamed R2 save. The route handler itself
 * (src/index.ts#handleCreatePdfJob) stays in index.ts next to the other
 * job-creation handlers and is the only piece of this feature that touches
 * enforceRateLimit / CONVERT_WORKFLOW.create — everything in *this* file is
 * either pure or R2-only, so it stays importable (and unit-testable) under
 * plain vitest without pulling in ratelimiter.ts's "cloudflare:workers"
 * runtime import (see test/pdf-options.test.ts, test/pdf-upload.test.ts, and
 * jobs.ts's identical doc comment about the same constraint).
 *
 * Response bodies here use the legacy `{"error": "<string>"}` shape (not
 * the new Router's `{error:{code,message}}`) to match convert.svelte.ts's
 * JobsPostResponse parsing — see claudedocs/pdf-upload-investigation.md §0/§5.4.
 */

export const DEFAULT_PDF_OPTIONS: PdfConvertOptions = {
  pages: "1-",
  rotation: 0,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  fit: "contain",
  marginPx: 0,
  threshold: 128,
  dither: true,
  ditherStrength: 0.8,
  invert: false,
};

const DEFAULT_MAX_UPLOAD_PDF_BYTES = 50_331_648; // 48 MiB (spec §11.4)

/** Max upload size; the MAX_UPLOAD_PDF_BYTES var overrides the 48 MiB default. */
export function resolveMaxUploadPdfBytes(
  env: Pick<Env, "MAX_UPLOAD_PDF_BYTES">,
): number {
  const configured = Number(env.MAX_UPLOAD_PDF_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_PDF_BYTES;
}

const ALLOWED_CONTENT_TYPES = new Set(["application/pdf", "application/x-pdf"]);

/** Content-Type check (spec §8.1): exact match, media-type parameters ignored. */
export function isAllowedPdfContentType(headerValue: string | null): boolean {
  if (headerValue === null) {
    return false;
  }
  const mediaType = headerValue.split(";")[0]?.trim().toLowerCase();
  return mediaType !== undefined && ALLOWED_CONTENT_TYPES.has(mediaType);
}

export type ContentLengthCheck =
  | { kind: "ok"; length: number }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "too-large"; length: number };

/** Content-Length check (spec §8.1): missing → 411, <=0/non-numeric → 400, over the cap → 413. */
export function checkContentLength(
  headerValue: string | null,
  maxBytes: number,
): ContentLengthCheck {
  if (headerValue === null) {
    return { kind: "missing" };
  }
  if (!/^\d+$/.test(headerValue)) {
    return { kind: "invalid" };
  }
  const length = Number(headerValue);
  if (!Number.isSafeInteger(length) || length <= 0) {
    return { kind: "invalid" };
  }
  if (length > maxBytes) {
    return { kind: "too-large", length };
  }
  return { kind: "ok", length };
}

const DEFAULT_PDF_FILENAME = "document.pdf";
const MAX_FILENAME_CHARS = 255;

/**
 * Sanitizes a decoded X-File-Name value per spec §8.1: strip control
 * characters and path separators, Unicode-normalize, cap at 255 code
 * points, fall back to "document.pdf" when empty, append ".pdf" when no
 * extension is present. Display/XTC-title use only — never a path or R2 key
 * (spec §12.3).
 */
export function sanitizeUploadFilename(raw: string): string {
  // Strip ASCII control characters (C0 range plus DEL) by code point
  // rather than a regex escape class.
  const withoutControlChars = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const isC0 = code < 0x20;
      const isDel = code === 0x7f;
      return !isC0 && !isDel;
    })
    .join("");
  const cleaned = withoutControlChars
    .replace(/[/\\]/g, "")
    .normalize("NFC")
    .trim();
  if (cleaned.length === 0) {
    return DEFAULT_PDF_FILENAME;
  }
  const capped = Array.from(cleaned).slice(0, MAX_FILENAME_CHARS).join("");
  if (capped.length === 0) {
    return DEFAULT_PDF_FILENAME;
  }
  return /\.[^./\\]+$/.test(capped) ? capped : `${capped}.pdf`;
}

/**
 * Decodes X-File-Name. The filename is display/title use only (spec §12.3),
 * so — unlike X-Pdf-Options below — a missing or undecodable header is not
 * a client error: it degrades to the default filename rather than failing
 * the whole upload over a cosmetic field.
 */
export function decodeFilenameHeader(headerValue: string | null): string {
  if (headerValue === null) {
    return DEFAULT_PDF_FILENAME;
  }
  const decoded = decodeBase64Url(headerValue);
  return decoded === null ? DEFAULT_PDF_FILENAME : sanitizeUploadFilename(decoded);
}

export type PdfOptionsResult =
  | { ok: true; options: PdfConvertOptions }
  | { ok: false; error: string };

const CROP_SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * Validates a decoded PdfConvertOptions JSON value against spec §5.3.
 * Strict: out-of-range or wrong-typed fields are rejected outright, never
 * silently clamped or defaulted (spec: "不正値は暗黙補正せず...400を返す").
 * Unknown extra properties on the input object are ignored (only the known
 * fields below are read), which keeps the schema forward-compatible without
 * being a form of implicit correction of an otherwise-invalid value.
 */
export function validatePdfConvertOptions(value: unknown): PdfOptionsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "pdf options must be a JSON object" };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.pages !== "string" || validatePageRangeSyntax(v.pages) !== null) {
    return { ok: false, error: "invalid pages" };
  }
  const pages = v.pages;

  if (v.rotation !== 0 && v.rotation !== 90 && v.rotation !== 180 && v.rotation !== 270) {
    return { ok: false, error: "invalid rotation" };
  }
  const rotation = v.rotation;

  if (typeof v.crop !== "object" || v.crop === null || Array.isArray(v.crop)) {
    return { ok: false, error: "invalid crop" };
  }
  const cropInput = v.crop as Record<string, unknown>;
  const crop = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of CROP_SIDES) {
    const side_value = cropInput[side];
    if (
      typeof side_value !== "number" ||
      !Number.isFinite(side_value) ||
      side_value < 0 ||
      side_value > 0.4
    ) {
      return { ok: false, error: `invalid crop.${side}` };
    }
    crop[side] = side_value;
  }
  if (crop.left + crop.right >= 0.8) {
    return { ok: false, error: "crop left + right must be less than 0.8" };
  }
  if (crop.top + crop.bottom >= 0.8) {
    return { ok: false, error: "crop top + bottom must be less than 0.8" };
  }

  if (v.fit !== "contain" && v.fit !== "cover") {
    return { ok: false, error: "invalid fit" };
  }
  const fit = v.fit;

  if (
    typeof v.marginPx !== "number" ||
    !Number.isInteger(v.marginPx) ||
    v.marginPx < 0 ||
    v.marginPx > 64
  ) {
    return { ok: false, error: "invalid marginPx" };
  }
  const marginPx = v.marginPx;

  if (
    typeof v.threshold !== "number" ||
    !Number.isInteger(v.threshold) ||
    v.threshold < 0 ||
    v.threshold > 255
  ) {
    return { ok: false, error: "invalid threshold" };
  }
  const threshold = v.threshold;

  if (typeof v.dither !== "boolean") {
    return { ok: false, error: "invalid dither" };
  }
  const dither = v.dither;

  if (
    typeof v.ditherStrength !== "number" ||
    !Number.isFinite(v.ditherStrength) ||
    v.ditherStrength < 0 ||
    v.ditherStrength > 1
  ) {
    return { ok: false, error: "invalid ditherStrength" };
  }
  const ditherStrength = v.ditherStrength;

  if (typeof v.invert !== "boolean") {
    return { ok: false, error: "invalid invert" };
  }
  const invert = v.invert;

  return {
    ok: true,
    options: { pages, rotation, crop, fit, marginPx, threshold, dither, ditherStrength, invert },
  };
}

/**
 * Decodes + validates X-Pdf-Options. Unlike the filename header, this drives
 * conversion behavior, so any failure (missing base64url, invalid UTF-8,
 * invalid JSON, schema violation) is a hard error — the caller turns it into
 * a 400. A wholly absent header falls back to DEFAULT_PDF_OPTIONS.
 */
export function decodePdfOptionsHeader(headerValue: string | null): PdfOptionsResult {
  if (headerValue === null) {
    return { ok: true, options: DEFAULT_PDF_OPTIONS };
  }
  const decoded = decodeBase64Url(headerValue);
  if (decoded === null) {
    return { ok: false, error: "X-Pdf-Options is not valid base64url UTF-8" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "X-Pdf-Options is not valid JSON" };
  }
  return validatePdfConvertOptions(parsed);
}

/**
 * Maps converter/pdf_upload.py's stable `code` field (see that module's
 * PdfUploadError docstring) to a stable NonRetryableError message. This is
 * the Container -> Workflow half of the error-code contract (spec §9.4/
 * §11.11): src/workflow.ts#runUploadedPdf calls this to turn a 400/415/422
 * Container response into a condition-specific message instead of one
 * generalized string; that message is what `instance.status().error.message`
 * exposes (src/jobs.ts), and frontend/src/lib/i18n.svelte.ts's
 * serverErrorText() matches on it to show a localized string (spec 14.2).
 *
 * Deliberately kept in this file (no "cloudflare:workers"/"cloudflare:
 * workflows" import) rather than in workflow.ts itself, so it stays
 * unit-testable under plain vitest — same constraint this file's own doc
 * comment already documents for saveUploadedPdf et al.
 *
 * Codes are mapped to human-readable English rather than passed through
 * raw, so an unrecognized code (older/mismatched Container image) can fall
 * back to the pre-existing generalized message instead of leaking a bare
 * code string to the client.
 */
const UPLOADED_PDF_ERROR_MESSAGES: Record<string, string> = {
  not_pdf: "uploaded file is not a PDF",
  invalid_pdf_options: "invalid PDF conversion options",
  encrypted_pdf: "uploaded PDF is encrypted",
  pdf_parse_failed: "unable to parse uploaded PDF",
  page_range_invalid: "invalid page range for uploaded PDF",
  no_pages_selected: "no pages selected for uploaded PDF",
};

/**
 * Extracts converter/pdf_upload.py's `code` field from a (non-2xx) response
 * body and resolves it to a stable message. bodyText is passed in rather
 * than the Response itself, since a Response body can only be consumed
 * once and the caller already needs it for logging.
 */
export function uploadedPdfErrorMessage(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "code" in parsed &&
      typeof (parsed as { code?: unknown }).code === "string"
    ) {
      const code = (parsed as { code: string }).code;
      if (code in UPLOADED_PDF_ERROR_MESSAGES) {
        return UPLOADED_PDF_ERROR_MESSAGES[code];
      }
    }
  } catch {
    // Non-JSON body shouldn't happen for this Container's error responses;
    // fall through to the generalized message below.
  }
  return "invalid or unsupported PDF";
}

async function deleteBestEffort(env: Pick<Env, "XTC_BUCKET">, key: string): Promise<void> {
  try {
    await env.XTC_BUCKET.delete(key);
  } catch (error) {
    console.error(`best-effort delete of ${key} failed`, error);
  }
}

export type SaveUploadedPdfResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Streams `body` into R2 at `key` and verifies the stored size against the
 * declared Content-Length (spec §8.1/§10.2/§10.3): never buffers the whole
 * PDF into a Worker-side ArrayBuffer (R2Bucket.put() accepts a ReadableStream
 * directly, unlike the Container fetch() call in src/container.ts, which
 * needs FixedLengthStream because its target http.server rejects chunked
 * bodies). On any failure the (possibly partial) R2 object is deleted before
 * returning, and the caller is expected to not start a Workflow.
 */
export async function saveUploadedPdf(
  env: Pick<Env, "XTC_BUCKET">,
  key: string,
  body: ReadableStream,
  declaredSize: number,
  filename: string,
): Promise<SaveUploadedPdfResult> {
  try {
    // customMetadata mirrors spec §8.1's R2 metadata table; sourceType lets
    // an operator distinguish input/ objects from other prefixes at a
    // glance (e.g. in the R2 dashboard) without decoding the key.
    await env.XTC_BUCKET.put(key, body, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { filename, sourceType: "pdf" },
    });
  } catch (error) {
    console.error(`R2 put ${key} failed`, error);
    await deleteBestEffort(env, key); // in case a partial object was written
    return { ok: false, status: 500, error: "failed to store upload" };
  }

  const stored = await env.XTC_BUCKET.head(key);
  if (stored === null || stored.size !== declaredSize) {
    console.error(
      `stored size ${stored?.size ?? "missing"} for ${key} != declared Content-Length ${declaredSize}`,
    );
    await deleteBestEffort(env, key);
    return {
      ok: false,
      status: 400,
      error: "uploaded PDF size does not match Content-Length",
    };
  }

  return { ok: true };
}
