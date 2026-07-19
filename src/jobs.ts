// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "./types";

/**
 * Pure helpers for the async job API: R2 key layout and the mapping from
 * Workflows instance statuses onto the public job statuses.
 *
 * Kept free of cloudflare:* / @cloudflare/* runtime imports so the mapping
 * logic stays unit-testable under plain vitest (see test/jobs.test.ts).
 */

/**
 * R2 key for the intermediate PDF. Lives under its own prefix (not jobs/)
 * because R2 lifecycle rules match on prefix only: intermediate/ expires
 * after 1 day, jobs/ after 24h as well (see claudedocs/deploy-guide.md).
 */
export function intermediatePdfKey(jobId: string): string {
  return `intermediate/${jobId}/source.pdf`;
}

/**
 * R2 key for the extracted-article HTML handed from the extract-content step
 * to render-pdf (extract mode only). Shares the intermediate/ prefix with the
 * PDF so the same 1-day R2 lifecycle rule covers it.
 */
export function articleHtmlKey(jobId: string): string {
  return `intermediate/${jobId}/article.html`;
}

/**
 * R2 key for the inlined @font-face CSS handed from extract-content to
 * render-pdf next to the article HTML (extract mode, font inlining
 * succeeded). Same intermediate/ prefix, same 1-day lifecycle.
 */
export function fontsCssKey(jobId: string): string {
  return `intermediate/${jobId}/fonts.css`;
}

/** R2 key for the finished XTC artifact. */
export function outputXtcKey(jobId: string): string {
  return `jobs/${jobId}/output.xtc`;
}

export type JobApiStatus =
  | "queued"
  | "rendering"
  | "converting"
  | "completed"
  | "failed";

/** Structural subset of the Workflows InstanceStatus this module depends on. */
export interface WorkflowStatusLike {
  status: InstanceStatus["status"];
  error?: { name: string; message: string };
  /** Workflow run() return value, exposed once the instance completes. */
  output?: unknown;
}

export interface JobStatusBody {
  jobId: string;
  status: JobApiStatus;
  downloadUrl?: string;
  /** Page title of the converted document, when one could be extracted. */
  title?: string;
  error?: string;
}

/**
 * True for the running family (running/waiting/paused/...), where the
 * rendering/converting split applies and an R2 probe for the intermediate
 * PDF is needed. The other statuses map without any probe.
 */
export function needsPhaseProbe(status: InstanceStatus["status"]): boolean {
  return (
    status !== "queued" &&
    status !== "complete" &&
    status !== "errored" &&
    status !== "terminated"
  );
}

/**
 * Maps a Workflows instance status onto the public API status. status() does
 * not expose the currently running step, so within the running family the
 * rendering/converting split is derived from whether the intermediate PDF
 * has been written to R2 yet (see claudedocs/phase2-findings.md).
 */
export function mapInstanceStatus(
  jobId: string,
  instance: WorkflowStatusLike,
  hasIntermediatePdf: boolean,
): JobStatusBody {
  switch (instance.status) {
    case "queued":
      return { jobId, status: "queued" };
    case "complete": {
      const title = titleFromOutput(instance.output);
      return {
        jobId,
        status: "completed",
        downloadUrl: `/jobs/${jobId}/download`,
        ...(title !== undefined ? { title } : {}),
      };
    }
    case "errored":
    case "terminated":
      return {
        jobId,
        status: "failed",
        error: instance.error?.message ?? "unknown error",
      };
    default:
      // running / waiting / paused / waitingForPause / unknown
      return { jobId, status: hasIntermediatePdf ? "converting" : "rendering" };
  }
}

export type DownloadDecision =
  | { kind: "not-found" }
  | { kind: "conflict"; status: JobApiStatus };

/**
 * Decides the response for GET /jobs/:id/download when output.xtc is absent.
 * completed-but-missing means the artifact already expired (R2 lifecycle);
 * failed jobs never produced one. Both are 404. Anything still in flight
 * is a 409 so pollers know to keep waiting.
 */
export function decideMissingDownload(status: JobStatusBody): DownloadDecision {
  if (status.status === "completed" || status.status === "failed") {
    return { kind: "not-found" };
  }
  return { kind: "conflict", status: status.status };
}

/** Longest title kept anywhere (filenames, R2 metadata, API bodies). */
const MAX_TITLE_CHARS = 100;

/**
 * Normalizes a document title for display and filename use: collapses
 * whitespace (incl. newlines), strips control characters and the path
 * separators / \, and caps the length. Returns undefined when nothing
 * usable remains, so callers fall back to the jobId.
 */
export function sanitizeTitle(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // Windows/FAT-forbidden filename characters: devices reject them on
    // transfer (an ASCII "|" in a title broke an upload to the X3), while
    // their full-width lookalikes (｜：？ etc.) are fine and kept as-is.
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cap by code points, not UTF-16 units: slicing through a surrogate pair
  // would leave a lone surrogate that makes encodeURIComponent throw when
  // the Content-Disposition header is built.
  const capped = Array.from(cleaned)
    .slice(0, MAX_TITLE_CHARS)
    .join("")
    .trim();
  return capped.length > 0 ? capped : undefined;
}

/**
 * Decodes the X-Xtc-Title response header set by converter/app.py
 * (UTF-8 percent-encoded, since HTTP headers are Latin-1 only).
 */
export function decodeTitleHeader(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    return sanitizeTitle(decodeURIComponent(value));
  } catch {
    return undefined; // malformed percent-encoding
  }
}

/** Extracts the title from an unknown-shaped Workflow run() output. */
export function titleFromOutput(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }
  return sanitizeTitle((output as { title?: unknown }).title as string);
}

/**
 * Builds the Content-Disposition for the .xtc download. Non-ASCII titles
 * (the normal case for Japanese pages) go into the RFC 5987 filename*
 * parameter; the plain filename carries an ASCII-only fallback so legacy
 * clients still get something sensible.
 */
export function xtcContentDisposition(
  title: string | undefined,
  jobId: string,
): string {
  const base = sanitizeTitle(title) ?? jobId;
  // Keep printable ASCII only (minus the quote, which would break the
  // quoted-string); everything else is representable via filename* alone.
  const asciiBase =
    sanitizeTitle(base.replace(/[^ -~]/g, " ").replace(/"/g, " ")) ??
    jobId;
  const encoded = encodeRfc5987(`${base}.xtc`);
  return `attachment; filename="${asciiBase}.xtc"; filename*=UTF-8''${encoded}`;
}

/** RFC 5987 ext-value percent-encoding (stricter than encodeURIComponent). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const DEFAULT_MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Max rendered-PDF size; the MAX_PDF_BYTES var overrides the 20 MiB default. */
export function resolveMaxPdfBytes(env: Pick<Env, "MAX_PDF_BYTES">): number {
  const configured = Number(env.MAX_PDF_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_PDF_BYTES;
}

const DEFAULT_EXTRACT_MIN_CHARS = 300;

/**
 * Minimum body length for extract mode to accept a Readability result; the
 * EXTRACT_MIN_CHARS var overrides the default 300. Measured in characters
 * after whitespace removal, not words, so CJK articles (dense, few spaces)
 * are judged on the same scale as Latin-script ones.
 */
export function resolveExtractMinChars(
  env: Pick<Env, "EXTRACT_MIN_CHARS">,
): number {
  const configured = Number(env.EXTRACT_MIN_CHARS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_EXTRACT_MIN_CHARS;
}
