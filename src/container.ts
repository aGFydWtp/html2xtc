// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { Container, getContainer } from "@cloudflare/containers";
import { encodeBase64Url } from "./base64url";
import { resolveMaxPdfBytes } from "./jobs";
import { resolveMaxUploadPdfBytes } from "./pdf-upload";
import type { Env, PdfConvertOptions } from "./types";
import type { XtcChapter } from "../packages/aozora-text/src/index";

export class XtcConverterContainer extends Container {
  // Requests block until the container listens on this port (app.py).
  defaultPort = 8080;
  // Billing runs from start to sleep, so keep the idle window short.
  sleepAfter = "2m";
  // Raise xtctool's subprocess timeout (app.py default: 120s) so Workflow
  // jobs can convert long documents. app.py's SIGTERM drain window follows
  // automatically (CONVERT_TIMEOUT_SECONDS + 10 = 610s).
  envVars = { XTC_TIMEOUT_SECONDS: "600" };
}

// Must match containers.max_instances in wrangler.jsonc: a fixed pool of
// names keeps requests landing on warm containers instead of cold-starting
// a new instance per jobId.
const CONVERTER_POOL_SIZE = 4;

// The container must abort its xtctool subprocess before this fetch aborts, so
// it frees its conversion slot instead of running to XTC_TIMEOUT_SECONDS. Give
// it a margin below the fetch budget for container startup + transfer.
const CONVERTER_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Hard cap on how many chapters ever reach the Container via X-Xtc-Chapters.
 * Measured motivation: a real-world sample of long-form Aozora works found a
 * 中見出し count as high as 584 in a single document — the device holds
 * every chapter name as a string in heap memory, and 584 names would use
 * roughly 30KB, worsening the device's known "52KB page-buffer allocation
 * can fail" issue (claudedocs/deploy-guide.md). The excess is simply
 * dropped, never sent — see capChapters below, which also logs the drop
 * (never silent).
 *
 * Deliberately kept ONLY here (the Worker), not duplicated in converter/:
 * which headings become chapters is an editorial decision the Worker owns
 * end to end (it already decided the heading LEVEL —
 * determineChapterHeadingLevel / determineAozoraChapterHeadingLevel); the
 * Container's job is only to resolve page numbers for whatever chapter list
 * it is handed, never to second-guess how many of them there should be.
 * Duplicating this constant on the Python side would just be two numbers
 * that can silently drift apart.
 */
const MAX_XTC_CHAPTERS = 200;

/**
 * Applies MAX_XTC_CHAPTERS: returns `chapters` unchanged when it already
 * fits, otherwise the first MAX_XTC_CHAPTERS entries (document order is
 * already chapter order, so "first" means "earliest in the book") — and
 * ALWAYS logs the drop, with both the original count and how many were
 * dropped, so a truncation is never silent. `undefined` (no chapters at
 * all) passes through untouched.
 */
function capChapters(
  jobId: string,
  chapters: XtcChapter[] | undefined,
): XtcChapter[] | undefined {
  if (chapters === undefined || chapters.length <= MAX_XTC_CHAPTERS) {
    return chapters;
  }
  const dropped = chapters.length - MAX_XTC_CHAPTERS;
  console.error(
    `[${jobId}] chapters truncated: ${chapters.length} exceeds the ${MAX_XTC_CHAPTERS}-chapter limit; sending only the first ${MAX_XTC_CHAPTERS} (dropped ${dropped})`,
  );
  return chapters.slice(0, MAX_XTC_CHAPTERS);
}

/**
 * Machine-readable X-Xtc-Chapters-Status values the Container is documented
 * to send (converter/app.py's side of this contract). Kept as a whitelist so
 * an unrecognized or missing value never reaches the log verbatim — see
 * logChapterDiagnostics below.
 */
const KNOWN_CHAPTER_STATUSES = new Set([
  "ok",
  "not-requested",
  "header-decode-failed",
  "pdf-metadata-failed",
  "detect-exception",
  "no-markers-found",
  "partial",
  "config-merge-failed",
]);

/** Parses an X-Xtc-Chapters-{Requested,Detected} header value: must be a
 * non-negative integer with no extra characters (rejects "12abc", "-1",
 * "1.5", scientific notation, etc.) — anything else is treated the same as
 * a missing header, never passed through to the log as-is. */
function parseChapterCountHeader(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Parses X-Xtc-Page-Count: per the contract an empty string means
 * read_pdf_metadata failed (distinct from the header being absent, e.g. an
 * older Container image that doesn't send it at all). Anything else reaches
 * the log only after the same digits-only + safe-integer check
 * parseChapterCountHeader applies, so this side never echoes a header value
 * it hasn't vetted. */
function formatPageCountHeader(raw: string | null): string {
  if (raw === null) {
    return "missing";
  }
  if (raw === "") {
    return "failed";
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return "invalid";
  }
  return raw;
}

/**
 * Logs the chapter-detection diagnostic headers the Container's /convert
 * response carries. The header contract itself lives in converter/app.py's
 * module docstring, NOT in this file — the two sides are implemented
 * independently and this is only the Worker half, so change neither without
 * the other.
 * `sentChaptersCount` is the post-capChapters count actually placed in the
 * X-Xtc-Chapters request header, so a single log line lets Workers Logs
 * answer "how many chapters did the Worker send → how many did the
 * Container decode → how many actually made it into the XTC", all three in
 * one grep-able `[jobId] chapters: ...` line.
 *
 * Silent (no log at all) when sentChaptersCount is 0: no chapters were
 * requested for this job, so there is nothing to diagnose and logging would
 * just be noise across every URL/TXT/EPUB job that has no chapters. Once a
 * job DID request chapters, this always logs — including when the response
 * carries no diagnostic headers at all (an older Container image, since this
 * header set can be deployed independently of the Worker), so a rollout gap
 * is visible rather than silently swallowed.
 *
 * Every header value is validated before it can reach the log line: an
 * unrecognized/missing status becomes the literal string "missing" or
 * "unknown" (never the raw header text), and count headers that fail to
 * parse as a plain non-negative integer become "unknown" — this keeps
 * arbitrary/malformed header content from ever being written to Workers
 * Logs. Only counts and the machine-readable status code are logged, never
 * chapter names, EPUB paths, or URLs (spec's own chapters carry no such
 * content in these headers to begin with, but the parsing above is the
 * enforcement point regardless).
 *
 * Uses console.warn (not console.error, which capChapters above reserves for
 * the truncation case) whenever the status is anything other than "ok" —
 * including "missing"/"unknown" — so a chapter-detection problem in
 * production stands out from the routine console.log lines around it.
 */
function logChapterDiagnostics(
  jobId: string,
  sentChaptersCount: number,
  response: Response,
): void {
  if (sentChaptersCount === 0) {
    return;
  }
  const rawStatus = response.headers.get("X-Xtc-Chapters-Status");
  const status =
    rawStatus === null ? "missing" : KNOWN_CHAPTER_STATUSES.has(rawStatus) ? rawStatus : "unknown";
  const requested = parseChapterCountHeader(response.headers.get("X-Xtc-Chapters-Requested"));
  const detected = parseChapterCountHeader(response.headers.get("X-Xtc-Chapters-Detected"));
  const pageCount = formatPageCountHeader(response.headers.get("X-Xtc-Page-Count"));
  const line =
    `[${jobId}] chapters: sent=${sentChaptersCount} ` +
    `requested=${requested ?? "unknown"} detected=${detected ?? "unknown"} ` +
    `status=${status} pageCount=${pageCount}`;
  if (status === "ok") {
    console.log(line);
  } else {
    console.warn(line);
  }
}

/**
 * Sends the PDF to the converter container and returns its response.
 * timeoutMs bounds the whole fetch: the sync /convert path passes a short
 * budget, the Workflow passes one sized for the 600s xtctool limit.
 * pdfBody may be a buffer (sync path, which already holds the bytes for the
 * concurrent R2 put) or a ReadableStream (workflow path, streaming from R2).
 * A stream MUST have a known length — pipe it through FixedLengthStream so
 * fetch sends Content-Length — because the container's http.server rejects
 * bodies without one (chunked requests are not parsed).
 *
 * `author` (optional) is forwarded as X-Xtc-Author, base64url-encoded UTF-8
 * (headers are Latin-1 only). Used only by the TXT-upload pipeline
 * (src/workflow.ts's text-source branch), which is the only caller with an
 * author to set — Chromium's print-to-PDF never populates the PDF /Author
 * field from the page itself the way it does /Title from document.title, so
 * unlike the title (read back from the PDF's own metadata by
 * converter/app.py#read_pdf_metadata), the author has to travel in on this
 * request instead. Omitted for URL-render jobs, which never have one; the
 * Container's own config-x3.toml default (`[output].author = ""`) governs
 * exactly as it always has.
 *
 * `chapters` (optional) is forwarded as X-Xtc-Chapters, base64url-encoded
 * UTF-8 JSON — same encoding convention as `author` above, for the same
 * reason (headers are Latin-1 only, chapter names are arbitrary UTF-8). Set
 * by every caller whose rendered HTML embedded the invisible chapter-marker
 * spans (the AST-based TXT-upload pipeline via src/text-prepare.ts, and the
 * Aozora Bunko URL-extraction path via src/aozora.ts, including its 4-chunk
 * timeout fallback) — omitted (not merely an empty array) when there are no
 * chapters, so the Container never has to distinguish "no header" from "an
 * empty array" itself. Capped at MAX_XTC_CHAPTERS (capChapters above) right
 * here, the one chokepoint every caller funnels through, rather than in each
 * caller separately.
 */
export async function convertInContainer(
  env: Env,
  jobId: string,
  pdfBody: ArrayBuffer | ReadableStream,
  timeoutMs: number,
  author?: string,
  chapters?: XtcChapter[],
): Promise<Response> {
  const container = getContainer(env.XTC_CONVERTER, converterInstanceName(jobId));
  // Per-request subprocess timeout for app.py, kept below this fetch's budget
  // so the container aborts xtctool first. XTC_TIMEOUT_SECONDS stays as the
  // absolute upper bound (defense in depth).
  const subprocessTimeoutSeconds = String(
    Math.max(1, Math.floor((timeoutMs - CONVERTER_TIMEOUT_MARGIN_MS) / 1000)),
  );
  const cappedChapters = capChapters(jobId, chapters);
  const sentChaptersCount = cappedChapters?.length ?? 0;
  const response = await container.fetch(
    new Request("http://converter/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Convert-Timeout-Seconds": subprocessTimeoutSeconds,
        // Worker owns the authoritative size limit; tell the container so its
        // 413 threshold tracks resolveMaxPdfBytes instead of its own default.
        "X-Max-Pdf-Bytes": String(resolveMaxPdfBytes(env)),
        ...(author !== undefined && author.length > 0
          ? { "X-Xtc-Author": encodeBase64Url(author) }
          : {}),
        ...(cappedChapters !== undefined && cappedChapters.length > 0
          ? { "X-Xtc-Chapters": encodeBase64Url(JSON.stringify(cappedChapters)) }
          : {}),
      },
      body: pdfBody,
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
  // Chapter-detection observability (see logChapterDiagnostics' doc comment):
  // reads response headers only, never the body, so this doesn't interfere
  // with the caller's own body handling (streamed or buffered) below.
  logChapterDiagnostics(jobId, sentChaptersCount, response);
  return response;
}

/**
 * Sends an uploaded (untrusted, external) PDF to the converter container's
 * dedicated endpoint and returns its response. Deliberately a separate
 * function from convertInContainer, not a shared one with an extra branch:
 * the target path, the trust model of the body (spec §12.1 — any PDF, not
 * just a Browser-Run-generated one), and the extra headers all differ (spec
 * §11.2). pdfBody MUST already carry a known length (piped through
 * FixedLengthStream by the caller) — see convertInContainer's doc for why:
 * the container's http.server rejects chunked bodies.
 *
 * X-Convert-Timeout-Seconds and X-Max-Pdf-Bytes stay plain decimal strings
 * (matching convertInContainer and the spec's own `<seconds>`/`<bytes>`
 * placeholders in §11.2's request example); X-Pdf-Options and
 * X-Source-Filename are base64url per spec §11.2, since headers are Latin-1
 * only and both carry arbitrary UTF-8.
 */
export function convertUploadedPdfInContainer(
  env: Env,
  jobId: string,
  pdfBody: ReadableStream,
  pdfOptions: PdfConvertOptions,
  filename: string,
  timeoutMs: number,
): Promise<Response> {
  const container = getContainer(env.XTC_CONVERTER, converterInstanceName(jobId));
  const subprocessTimeoutSeconds = String(
    Math.max(1, Math.floor((timeoutMs - CONVERTER_TIMEOUT_MARGIN_MS) / 1000)),
  );
  return container.fetch(
    new Request("http://converter/convert/uploaded-pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Convert-Timeout-Seconds": subprocessTimeoutSeconds,
        "X-Max-Pdf-Bytes": String(resolveMaxUploadPdfBytes(env)),
        "X-Pdf-Options": encodeBase64Url(JSON.stringify(pdfOptions)),
        "X-Source-Filename": encodeBase64Url(filename),
      },
      body: pdfBody,
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
}

/** Maps a jobId onto the fixed converter pool (warm-container reuse). */
function converterInstanceName(jobId: string): string {
  let hash = 0;
  for (let i = 0; i < jobId.length; i++) {
    hash = (hash * 31 + jobId.charCodeAt(i)) >>> 0;
  }
  return `converter-${hash % CONVERTER_POOL_SIZE}`;
}
