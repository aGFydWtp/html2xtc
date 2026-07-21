// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { Container, getContainer } from "@cloudflare/containers";
import { encodeBase64Url } from "./base64url";
import { resolveMaxPdfBytes } from "./jobs";
import { resolveMaxUploadPdfBytes } from "./pdf-upload";
import type { Env, PdfConvertOptions } from "./types";

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
 */
export function convertInContainer(
  env: Env,
  jobId: string,
  pdfBody: ArrayBuffer | ReadableStream,
  timeoutMs: number,
  author?: string,
): Promise<Response> {
  const container = getContainer(env.XTC_CONVERTER, converterInstanceName(jobId));
  // Per-request subprocess timeout for app.py, kept below this fetch's budget
  // so the container aborts xtctool first. XTC_TIMEOUT_SECONDS stays as the
  // absolute upper bound (defense in depth).
  const subprocessTimeoutSeconds = String(
    Math.max(1, Math.floor((timeoutMs - CONVERTER_TIMEOUT_MARGIN_MS) / 1000)),
  );
  return container.fetch(
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
      },
      body: pdfBody,
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
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
