// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  allAozoraFallbackKeys,
  aozoraFallbackChunkHtmlKey,
  aozoraFallbackChunkId,
  aozoraFallbackChunkPdfKey,
  aozoraFallbackManifestKey,
} from "./aozora-fallback/keys";
import type { AozoraFallbackChunkIndex } from "./aozora-fallback/keys";
import { buildAozoraFallbackChunkHtml, parseAozoraArticleDocument } from "./aozora-fallback/html";
import {
  parseAozoraFallbackManifest,
  serializeAozoraFallbackManifest,
} from "./aozora-fallback/manifest";
import type { AozoraFallbackManifest, AozoraFallbackManifestChunk } from "./aozora-fallback/manifest";
import {
  MAX_FALLBACK_MERGE_INPUT_BYTES,
  MAX_FALLBACK_MERGE_PAGES,
  MERGE_ERROR_FAILED,
  MERGE_ERROR_TOO_LARGE,
  countPdfPages,
  mergeChunkPdfs,
  totalBytes,
} from "./aozora-fallback/merge-pdf";
import { computeDocumentMetrics } from "./aozora-fallback/metrics";
import { writeAozoraFallbackProgress } from "./aozora-fallback/progress";
import { splitContentIntoChunks } from "./aozora-fallback/split";
import { convertInContainer, convertUploadedPdfInContainer } from "./container";
import { DEFAULT_EPUB_OPTIONS } from "./epub-options";
import type { EpubConvertOptions } from "./epub-options";
import {
  resolveMaxEpubEntries,
  resolveMaxEpubEntryBytes,
  resolveMaxEpubUncompressedBytes,
} from "./epub/archive";
import { EpubError } from "./epub/errors";
import { prepareEpubDocument } from "./epub/html";
import { resolveMaxUploadEpubBytes } from "./epub-upload";
import { prepareRenderInput } from "./extract";
import { resolveAozoraTimeoutFallbackEnabled } from "./feature-flags";
import { buildInlineFontCss } from "./fonts";
import {
  articleHtmlKey,
  epubFontsCssKey,
  epubHtmlKey,
  fontsCssKey,
  intermediatePdfKey,
  outputXtcKey,
  resolveMaxEpubHtmlBytes,
  resolveMaxPdfBytes,
} from "./jobs";
import { renderPdf, renderPdfFromHtml, renderSelfStyledHtmlPdf, formatJstTimestamp } from "./pdf";
import {
  DEFAULT_PDF_OPTIONS,
  resolveMaxUploadPdfBytes,
  uploadedPdfErrorMessage,
} from "./pdf-upload";
import { storeXtcOutput } from "./pipeline";
import { isAozoraBunkoUrl, resolveRenderOptions } from "./sitepresets";
import { decodeTextFile } from "./text-decode";
import {
  MAX_GENERATED_HTML_BYTES,
  MAX_TEXT_FILE_BYTES,
  TextTooLongError,
  validateTextLimits,
} from "./text-normalize";
import { prepareTextDocument } from "./text-prepare";
import { DEFAULT_TEXT_OPTIONS } from "./text-options";
import type { TextConvertOptions } from "./text-options";
import { textPrepareErrorMessage } from "./text-upload";
import type { ConvertJobParams, ConvertSource, Env, PdfConvertOptions, RenderOptions } from "./types";
import { AozoraAstLimitExceededError } from "../packages/aozora-text/src/index";

// xtctool may run up to 600s (XTC_TIMEOUT_SECONDS in container.ts); allow a
// 30s margin for transfer and container startup. Must stay below the step
// timeout ("12 minutes") or the fetch would never get to time out itself.
const CONVERTER_FETCH_TIMEOUT_MS = 630_000;

/**
 * Normalizes a job's payload to a single ConvertSource (spec §9.1). `source`
 * wins when both are present; `url` is the pre-source legacy shape, kept
 * only for backward compatibility with jobs created before this field
 * existed. Neither present is a payload the Worker should never produce —
 * treated as non-retryable rather than silently defaulting to anything.
 */
export function resolveSource(payload: ConvertJobParams): ConvertSource {
  if (payload.source) {
    return payload.source;
  }
  if (payload.url) {
    return { kind: "url", url: payload.url };
  }
  throw new NonRetryableError("conversion source is missing");
}

/**
 * Container response statuses that mean "this exact input will never
 * succeed" (spec §9.4/§11.11): malformed/non-PDF body (400/415), or a PDF
 * PyMuPDF could open but had to reject (422 — encrypted, unparseable,
 * page-range/selection problems). 413 is handled separately (its own
 * message). Anything else (500/503/network) is left retryable.
 */
function isNonRetryableUploadedPdfStatus(status: number): boolean {
  return status === 400 || status === 415 || status === 422;
}

/**
 * Browser Run's own machine-readable code for "a timeout was reached...
 * Request timed out" (measured in prod: every render-pdf capture that blew
 * the ~60s quickAction budget on aozora.gr.jp's 神曲・淨火 returned exactly
 * this code). Cloudflare's Browser Run FAQ documents that HTTP 422 alone
 * covers OOM and page-crash failures too, not only timeouts — so this code,
 * not the status, is what must gate the timeout-specific message below.
 *
 * NOT used to change retry behavior (unlike EpubError's
 * DETERMINISTIC_ERROR_CODES allowlist, src/epub/errors.ts): the same code
 * failed 淨火 15/15 times but let 吾輩は猫である succeed on a later retry, so
 * it is not reliably deterministic and `retries` on the render-* steps stays
 * exactly as configured.
 */
const BROWSER_RUN_TIMEOUT_CODE = 6002;

/**
 * Best-effort extraction of `errors[0].code` from a failed Browser Run
 * quickAction response body. Never throws: a body that isn't JSON, or JSON
 * without the expected shape, degrades to `null` — same fail-safe stance as
 * isNonRetryableUploadedPdfStatus/EpubError's code allowlists, an
 * unrecognized shape must never be mistaken for a match.
 */
function parseBrowserRunErrorCode(bodyText: string): number | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const code = (parsed as { errors?: Array<{ code?: unknown }> })?.errors?.[0]?.code;
    return typeof code === "number" ? code : null;
  } catch {
    return null;
  }
}

/**
 * Client-facing message for a failed render-pdf/render-text-pdf/
 * render-epub-pdf step. Deliberately NOT keyed off `response.status === 422`
 * (see BROWSER_RUN_TIMEOUT_CODE's comment) — only this code selects the
 * timeout-specific message; every other code (or an unparseable body) keeps
 * the existing generic message.
 * frontend/src/lib/server-error-text.ts maps both exact strings to i18n
 * keys — keep the two in sync.
 */
function browserRunPdfErrorMessage(code: number | null): string {
  return code === BROWSER_RUN_TIMEOUT_CODE
    ? "PDF generation timed out; retrying may succeed"
    : "PDF generation failed";
}

/**
 * Client-facing message for a failed render-aozora-fallback-* chunk step
 * (Aozora timeout-fallback spec §19). Deliberately a DIFFERENT string from
 * browserRunPdfErrorMessage's timeout case ("...retrying may succeed") even
 * though both key off the same BROWSER_RUN_TIMEOUT_CODE: this one only ever
 * fires once a 4-chunk split already happened, so telling it apart in logs/
 * error text matters. Per spec §16.3/§19 "MVPではretry後failed" — a chunk
 * hitting 6002 is NOT retried more aggressively or split further, it just
 * uses the render-*-fallback step's existing retry budget like every other
 * render step, then fails the whole job on exhaustion.
 */
function browserRunFallbackChunkErrorMessage(code: number | null): string {
  return code === BROWSER_RUN_TIMEOUT_CODE
    ? "PDF generation timed out after fallback splitting"
    : "PDF generation failed";
}

/**
 * render-pdf's outcome for an Aozora Bunko job (spec §8): "success" is the
 * existing single-document result; "fallback-timeout" means Browser Run
 * reported code 6002 for this exact input and the step deliberately did NOT
 * throw (see the call site) — the same document is never retried through
 * render-pdf's own retry budget for this outcome (spec §27 "初回6002を複数回
 * retryしない"), it goes straight to the 4-chunk split instead. Every other
 * failure (network/5xx, or 6002 with the fallback flag off or on a
 * non-Aozora-origin document) still throws exactly as before.
 */
type InitialAozoraRenderResult =
  | { outcome: "success"; pdfKey: string; elapsedMs: number; browserMs: number | null }
  | { outcome: "fallback-timeout"; code: 6002; elapsedMs: number; browserMs: number | null };

/**
 * Conversion pipeline behind POST /jobs (extract mode and Aozora Bunko URLs
 * run extract-content first
 * → then always render-pdf → convert-xtc → delete-intermediate-pdf). The
 * instance ID doubles as
 * the public jobId, and the R2 keys are derived from it, so no extra job
 * store is needed (see claudedocs/phase2-findings.md).
 *
 * Each step is self-contained (re-reads its input from R2) so a retry of one
 * step never depends on in-memory state from another attempt. Steps return
 * only small JSON (R2 keys): step outputs are capped at 1 MiB.
 */
export class ConvertWorkflow extends WorkflowEntrypoint<Env, ConvertJobParams> {
  async run(event: WorkflowEvent<ConvertJobParams>, step: WorkflowStep) {
    const jobId = event.instanceId;
    const source = resolveSource(event.payload);

    if (source.kind === "pdf") {
      return await this.runUploadedPdf(
        jobId,
        source,
        event.payload.pdfOptions ?? DEFAULT_PDF_OPTIONS,
        step,
      );
    }

    if (source.kind === "text") {
      return await this.runTextSource(
        jobId,
        source,
        event.payload.textOptions ?? DEFAULT_TEXT_OPTIONS,
        step,
      );
    }

    if (source.kind === "epub") {
      return await this.runEpubSource(
        jobId,
        source,
        event.payload.epubOptions ?? DEFAULT_EPUB_OPTIONS,
        step,
      );
    }

    const { url } = source;
    // Params created before extract mode existed carry no mode field.
    const mode = event.payload.mode ?? "full";

    // Extract mode inserts one step ahead of render-pdf. The step itself
    // never throws for extraction problems — prepareRenderInput degrades
    // internally, and a null articleKey just means "render the URL as
    // always" — so a broken extraction can never fail a job that full mode
    // would have completed. The extracted HTML travels through R2, not the
    // step return value (step outputs are capped at 1 MiB).
    let articleKey: string | null = null;
    let fontsKey: string | null = null;
    // True only when prepareRenderInput's dedicated Aozora extractor itself
    // produced the article (RenderInput.origin === "aozora"), never when an
    // Aozora URL degraded to the generic extractor — the timeout-fallback's
    // eligibility gate (spec §9 "青空文庫専用抽出が成功") reads this, not
    // isAozoraBunkoUrl(target) alone.
    let isAozoraOrigin = false;
    // Render options resolved deterministically from the params (explicit
    // layout/font win; blanks fall back to per-site defaults — Aozora
    // Bunko: vertical + BIZ UDMincho). Pure derivation, so it needs no step
    // and every step attempt computes the same value.
    const target = new URL(url);
    const options = resolveRenderOptions(target, event.payload.layout, event.payload.font);
    // Aozora Bunko URLs run the extract-content step regardless of mode:
    // their dedicated extraction lives behind prepareRenderInput, which for
    // mode "full" degrades back to the plain URL render on any problem.
    if (mode === "extract" || isAozoraBunkoUrl(target)) {
      ({ articleKey, fontsKey, isAozoraOrigin } = await step.do(
        "extract-content",
        {
          retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
          // Worst case: source fetch (15s) + DoH re-validation per redirect
          // hop + content-action goto (60s) + the font-subsetting phase (up
          // to 8 css2 + 16 woff2 fetches at 10s each, run in parallel —
          // src/fonts.ts), plus margin for R2 I/O.
          timeout: "3 minutes",
        },
        async () => {
          const input = await prepareRenderInput(
            this.env,
            new URL(url),
            jobId,
            undefined,
            undefined,
            mode,
            options,
          );
          if (input.kind === "url") {
            return { articleKey: null, fontsKey: null, isAozoraOrigin: false };
          }
          const key = articleHtmlKey(jobId);
          try {
            await this.env.XTC_BUCKET.put(key, input.html, {
              httpMetadata: { contentType: "text/html; charset=utf-8" },
            });
          } catch (error) {
            // Same invariant as prepareRenderInput itself: extract mode must
            // never fail a job that full mode would complete. A transient R2
            // failure here costs only the extraction, not the conversion.
            console.error(
              `[${jobId}] R2 put ${key} failed; falling back to full render`,
              error,
            );
            return { articleKey: null, fontsKey: null, isAozoraOrigin: false };
          }
          // The inlined font CSS rides a second key: it is injected via
          // addStyleTag at render time (the docs-supported custom-font path
          // for quick actions) rather than embedded in the HTML. Losing it
          // costs only the font, not the extraction.
          let storedFontsKey: string | null = null;
          if (input.fontCss !== null) {
            const fKey = fontsCssKey(jobId);
            try {
              await this.env.XTC_BUCKET.put(fKey, input.fontCss, {
                httpMetadata: { contentType: "text/css; charset=utf-8" },
              });
              storedFontsKey = fKey;
            } catch (error) {
              console.error(
                `[${jobId}] R2 put ${fKey} failed; rendering without the inline font`,
                error,
              );
            }
          }
          return {
            articleKey: key,
            fontsKey: storedFontsKey,
            isAozoraOrigin: input.origin === "aozora",
          };
        },
      ));
    }

    const initialRender: InitialAozoraRenderResult = await step.do(
      "render-pdf",
      {
        retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        // Must cover a worst-case legitimate render: goto cap (25s,
        // PDF_GOTO_OPTIONS) + fixed lazy-image/font grace (10s,
        // PDF_FULL_WAIT_MS) + pdf generation cap (300s) in pdf.ts, plus
        // margin for R2 I/O.
        timeout: "7 minutes",
      },
      async (): Promise<InitialAozoraRenderResult> => {
        // Extract mode reads the prepared article HTML back from R2; a
        // missing object (expired mid-job) degrades to the full render
        // rather than failing — same always-produce-output stance as the
        // extract step itself.
        const article =
          articleKey !== null
            ? await this.env.XTC_BUCKET.get(articleKey)
            : null;
        if (articleKey !== null && article === null) {
          console.error(
            `[${jobId}] article HTML missing from R2; falling back to full render`,
          );
        }
        let response: Response;
        let renderStart: number;
        // articleBytes/fontCssBytes stay null on the full-page branch
        // (renderPdf sends only the target URL — no HTML/CSS payload of our
        // own rides along, so 0 would misleadingly read as "sent, but
        // empty"); the extract-mode branch below fills them with the actual
        // quickAction payload size. `mode` records which branch ran so a log
        // line's null bytes can be told apart from "extract sent 0 bytes".
        let articleBytes: number | null = null;
        let fontCssBytes: number | null = null;
        let mode: "extract" | "full";
        // Kept only for the Aozora-specific diagnostic log below (spec
        // §21); null whenever isAozoraOrigin is false, so the extra
        // parse/count work in computeDocumentMetrics never runs for
        // non-Aozora jobs.
        let articleHtmlForAozoraLog: string | null = null;
        if (article !== null) {
          mode = "extract";
          // Missing/unreadable fonts.css only degrades the font (the render
          // falls back to the @import variant inside renderPdfFromHtml).
          let fontCss: string | null = null;
          if (fontsKey !== null) {
            try {
              const fonts = await this.env.XTC_BUCKET.get(fontsKey);
              fontCss = fonts !== null ? await fonts.text() : null;
            } catch (error) {
              console.error(`[${jobId}] R2 get ${fontsKey} failed`, error);
            }
            if (fontCss === null) {
              console.error(
                `[${jobId}] fonts.css unavailable; rendering with the remote-font fallback`,
              );
            }
          }
          const articleHtml = await article.text();
          articleBytes = new TextEncoder().encode(articleHtml).length;
          if (fontCss !== null) {
            fontCssBytes = new TextEncoder().encode(fontCss).length;
          }
          if (isAozoraOrigin) {
            articleHtmlForAozoraLog = articleHtml;
          }
          // Measured from immediately before the quickAction call only: R2
          // I/O and the .text()/TextEncoder work above must stay outside
          // elapsedMs, or it stops reflecting capture time (the thing this
          // log exists to observe).
          renderStart = Date.now();
          response = await renderPdfFromHtml(
            this.env,
            articleHtml,
            fontCss,
            options,
          );
        } else {
          mode = "full";
          renderStart = Date.now();
          response = await renderPdf(this.env, url, options);
        }
        const elapsedMs = Date.now() - renderStart;
        // Browser Rendering's Quick Actions always report the browser time a
        // request consumed via this header (Cloudflare docs); this is the
        // only way to observe capture duration once the quickAction budget
        // (~60s) is exhausted and the request itself times out. An empty or
        // non-numeric header (unconfirmed whether this ever happens) must not
        // silently read as "0ms" or "NaN", hence the isFinite guard.
        const browserMsHeader = response.headers.get("X-Browser-Ms-Used");
        const browserMsParsed =
          browserMsHeader !== null ? Number(browserMsHeader) : NaN;
        const browserMs = Number.isFinite(browserMsParsed) ? browserMsParsed : null;
        // Read the body once, ahead of the log line, so both the code
        // classification and the (unchanged) console.error detail can use
        // it; response.text() cannot be called twice. Left null on success:
        // response.arrayBuffer() below reads the real PDF bytes instead.
        let browserRunErrorBody: string | null = null;
        let browserRunErrorCode: number | null = null;
        if (!response.ok) {
          browserRunErrorBody = await response.text();
          browserRunErrorCode = parseBrowserRunErrorCode(browserRunErrorBody);
        }
        console.log(`[${jobId}] render-pdf`, {
          mode,
          ok: response.ok,
          status: response.status,
          elapsedMs,
          browserMs,
          articleBytes,
          fontCssBytes,
          code: browserRunErrorCode,
        });
        // Aozora timeout-fallback eligibility (spec §8/§9): only a document
        // whose article HTML came from the DEDICATED Aozora extractor
        // (isAozoraOrigin), only when THIS attempt actually rendered that
        // article HTML (mode === "extract" — isAozoraOrigin alone is not
        // enough: if the R2 object expired mid-job, the `article === null`
        // branch above degrades this specific attempt to mode "full",
        // rendering the plain URL instead, and there is no article HTML left
        // to split), only on this exact machine-readable code, only when the
        // flag is on. Every other failure (network/5xx, non-6002, 6002 on a
        // non-Aozora-origin or degraded-to-full-render attempt, or 6002 with
        // the flag off) falls through to the unchanged throw below and keeps
        // using render-pdf's own retry budget exactly as before this feature
        // existed.
        const aozoraFallbackEnabled = resolveAozoraTimeoutFallbackEnabled(this.env);
        const isFallbackTimeout =
          !response.ok &&
          isAozoraOrigin &&
          mode === "extract" &&
          aozoraFallbackEnabled &&
          browserRunErrorCode === BROWSER_RUN_TIMEOUT_CODE;
        if (articleHtmlForAozoraLog !== null) {
          const metrics = computeDocumentMetrics(articleHtmlForAozoraLog);
          console.log(`[${jobId}] aozora initial render`, {
            outcome: response.ok ? "success" : isFallbackTimeout ? "fallback-timeout" : "failed",
            status: response.status,
            code: browserRunErrorCode,
            elapsedMs,
            browserMs,
            articleBytes,
            fontCssBytes,
            textLength: metrics.textLength,
            elementCount: metrics.elementCount,
            rubyCount: metrics.rubyCount,
            brCount: metrics.brCount,
            imageCount: metrics.imageCount,
          });
        }
        if (!response.ok) {
          // Upstream detail goes to logs only; the thrown message surfaces
          // to the client via instance.status().error on final failure.
          console.error(
            `[${jobId}] Browser Run returned ${response.status}: ${browserRunErrorBody}`,
          );
          if (isFallbackTimeout) {
            // Deliberately NOT thrown (spec §8/§27 "初回6002を複数回retry
            // しない"): a plain return here means step.do() sees this as a
            // successful attempt, so render-pdf's own retry budget is never
            // spent replaying the exact same 120s-timeout capture. The
            // caller below routes this outcome into the 4-chunk split
            // instead of convert-xtc.
            return {
              outcome: "fallback-timeout",
              code: BROWSER_RUN_TIMEOUT_CODE,
              elapsedMs,
              browserMs,
            };
          }
          throw new Error(browserRunPdfErrorMessage(browserRunErrorCode));
        }
        // Deliberately buffered, not streamed: the size gate needs the byte
        // count, Browser Rendering's response has no Content-Length we could
        // trust for a pre-check (and R2 put would need a known length to
        // accept a stream anyway). One PDF-sized buffer (<= MAX_PDF_BYTES,
        // 48 MiB in production) fits comfortably in the Worker's 128 MB
        // memory; R2 put consumes it without another JS-visible copy.
        const pdfBytes = await response.arrayBuffer();
        const maxPdfBytes = resolveMaxPdfBytes(this.env);
        if (pdfBytes.byteLength > maxPdfBytes) {
          // Deterministic failure: retrying would render the same PDF.
          throw new NonRetryableError(
            `rendered PDF exceeds the ${maxPdfBytes} byte limit; try a shorter page or the layout-preserving (full) mode`,
          );
        }
        const key = intermediatePdfKey(jobId);
        await this.env.XTC_BUCKET.put(key, pdfBytes, {
          httpMetadata: { contentType: "application/pdf" },
        });
        return { outcome: "success", pdfKey: key, elapsedMs, browserMs };
      },
    );

    // aozoraFallbackKeys stays empty unless the branch below actually runs
    // the 4-chunk pipeline — delete-intermediate-pdf's cleanup (finally,
    // below) only needs to know these keys when they exist. Declared outside
    // the try below (along with pdfKey) so a THROW from either branch —
    // including runAozoraTimeoutFallback itself, e.g. a chunk that never
    // recovers from code 6002 — still reaches the finally's cleanup with
    // whatever keys were already written (spec §16.6 "成功・失敗にかかわらず
    // 削除する" / §5's "中間成果物を成功・失敗にかかわらず削除する").
    let aozoraFallbackKeys: string[] = [];
    let pdfKey: string | null = null;
    try {
      if (initialRender.outcome === "success") {
        pdfKey = initialRender.pdfKey;
      } else {
        // initialRender.outcome === "fallback-timeout": split the Aozora
        // article into 4 balanced chunks, render each individually, merge
        // the resulting PDFs with pdf-lib, and write the result to the SAME
        // intermediatePdfKey(jobId) ("source.pdf") the normal path uses —
        // convert-xtc below needs no branch of its own (spec §16.5/§20
        // "source.pdf は通常経路とfallbackで同じ後段契約").
        aozoraFallbackKeys = allAozoraFallbackKeys(jobId);
        pdfKey = await this.runAozoraTimeoutFallback(jobId, url, articleKey, fontsKey, options, step);
      }

      const { xtcKey, title } = await step.do(
        "convert-xtc",
        {
          retries: { limit: 2, delay: "30 seconds", backoff: "constant" },
          // Explicit: the default step timeout (10 minutes per attempt) is too
          // tight for a conversion that may itself take up to 10 minutes.
          timeout: "12 minutes",
        },
        async () => {
          // pdfKey is always set by this point — both branches above assign
          // it (or throw) before convert-xtc ever runs; TypeScript cannot
          // narrow across this async closure boundary on its own.
          const source = await this.env.XTC_BUCKET.get(pdfKey!);
          if (source === null) {
            // Only possible if the intermediate expired mid-job (1-day
            // lifecycle) or was deleted; re-rendering is out of scope here.
            throw new NonRetryableError("intermediate PDF is missing");
          }
          let response: Response;
          try {
            // Stream R2 -> container instead of buffering the whole PDF:
            // FixedLengthStream (length known exactly from the R2 object)
            // makes fetch send Content-Length, which the container's
            // http.server requires — a bare stream would arrive chunked and
            // be rejected. Keeps this step's memory at chunk size instead of
            // a full PDF buffer (48 MiB at the production limit). On a
            // mid-stream failure the step retries from the R2 get, so the
            // consumed body is not a problem.
            response = await convertInContainer(
              this.env,
              jobId,
              source.body.pipeThrough(new FixedLengthStream(source.size)),
              CONVERTER_FETCH_TIMEOUT_MS,
            );
          } catch (error) {
            if (error instanceof DOMException && error.name === "TimeoutError") {
              // Hitting the full 630s budget means the document is too large
              // for xtctool's 600s limit; retrying would burn another ~10.5
              // minutes of container time for the same outcome.
              throw new NonRetryableError(
                "XTC conversion timed out; the document is too large",
              );
            }
            throw error; // network/container failures stay retryable
          }
          if (!response.ok) {
            console.error(
              `[${jobId}] converter returned ${response.status}: ${await response.text()}`,
            );
            // A container 413 means the PDF cleared the render-step size check
            // but the container still rejected it as oversized; retrying would
            // hit the same limit, so fail non-retryably with a size message.
            if (response.status === 413) {
              throw new NonRetryableError(
                `rendered PDF exceeds the ${resolveMaxPdfBytes(this.env)} byte limit; try a shorter page or the layout-preserving (full) mode`,
              );
            }
            throw new Error("XTC conversion failed");
          }
          const { title } = await storeXtcOutput(this.env, jobId, response);
          return { xtcKey: outputXtcKey(jobId), title };
        },
      );

      // Exposed through instance.status().output once the run completes;
      // GET /jobs/:id surfaces the title from here.
      return { xtcKey, title };
    } finally {
      // Runs on success and on terminal failure (retries exhausted or
      // NonRetryableError) alike. Deliberately NOT inside the convert step:
      // deleting there would starve that step's own retries of their input.
      // Best-effort — if the delete itself fails, the R2 lifecycle rule on
      // intermediate/ still removes the object within ~a day.
      await step.do("delete-intermediate-pdf", async () => {
        const keys = [pdfKey, articleKey, fontsKey, ...aozoraFallbackKeys].filter(
          (key): key is string => key !== null,
        );
        for (const key of keys) {
          try {
            await this.env.XTC_BUCKET.delete(key);
          } catch (error) {
            console.error(`[${jobId}] best-effort delete of ${key} failed`, error);
          }
        }
      });
    }
  }

  /**
   * The Aozora Bunko timeout fallback (spec §14/§16.2-§16.4): only invoked
   * when render-pdf's own step.do already returned "fallback-timeout"
   * (isAozoraOrigin && the flag on && Browser Run code 6002), so
   * `articleKey` is guaranteed non-null here.
   *
   * 1. prepare-aozora-fallback: DOM-splits the article into 4 balanced
   *    pieces (src/aozora-fallback/split.ts) and writes 4 chunk HTML
   *    documents + a manifest to R2.
   * 2. render-aozora-fallback-0000..0003: 4 SEQUENTIAL step.do calls (spec
   *    §27 "チャンクを並列処理しない") — each renders one chunk with the
   *    SAME shared fonts.css the initial attempt already produced (spec §27
   *    "フォントCSSを4回生成しない"; never regenerated here).
   * 3. merge-aozora-fallback-pdf: concatenates the 4 chunk PDFs with pdf-lib
   *    and writes the result to the EXISTING intermediatePdfKey(jobId)
   *    ("source.pdf") — the same key/contract the normal path uses, so the
   *    caller's convert-xtc step needs no branch of its own (spec §16.5/
   *    §20).
   *
   * Returns the R2 key of the merged PDF (always intermediatePdfKey(jobId)).
   */
  private async runAozoraTimeoutFallback(
    jobId: string,
    sourceUrl: string,
    articleKey: string | null,
    fontsKey: string | null,
    options: RenderOptions,
    step: WorkflowStep,
  ): Promise<string> {
    const SPLIT_FAILED_MESSAGE = "the document could not be split safely";

    const manifestKey = await step.do(
      "prepare-aozora-fallback",
      {
        // No retry budget beyond one extra attempt: a split/parse failure
        // here is deterministic for this exact article HTML (see the
        // NonRetryableError throws below) — the single retry only covers a
        // transient R2 get/put hiccup, mirroring prepare-text/prepare-epub's
        // identical stance (src/workflow.ts's other prepare-* steps).
        retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
        timeout: "2 minutes",
      },
      async () => {
        if (articleKey === null) {
          // Unreachable in practice — the caller only invokes this method
          // when render-pdf's extract-mode branch (which requires a non-null
          // articleKey) already ran — but keeps this step's input contract
          // explicit and satisfies strict null checking.
          throw new NonRetryableError(SPLIT_FAILED_MESSAGE);
        }
        const article = await this.env.XTC_BUCKET.get(articleKey);
        if (article === null) {
          // Only possible if the intermediate expired mid-job.
          throw new NonRetryableError(SPLIT_FAILED_MESSAGE);
        }
        const parsed = parseAozoraArticleDocument(await article.text());
        if (parsed === null) {
          throw new NonRetryableError(SPLIT_FAILED_MESSAGE);
        }
        let domChunks: ReturnType<typeof splitContentIntoChunks>;
        try {
          domChunks = splitContentIntoChunks(parsed.contentHtml);
        } catch (error) {
          console.error(`[${jobId}] aozora fallback split failed`, error);
          throw new NonRetryableError(SPLIT_FAILED_MESSAGE);
        }

        const convertedAt = formatJstTimestamp(new Date());
        const manifestChunks: AozoraFallbackManifestChunk[] = [];
        let totalTextLength = 0;
        for (let index = 0; index < 4; index++) {
          const chunkIndex = index as AozoraFallbackChunkIndex;
          const dom = domChunks[index];
          const chunkHtml = buildAozoraFallbackChunkHtml(dom.html, chunkIndex, {
            title: parsed.title,
            byline: parsed.byline,
            sourceUrl,
            convertedAt,
          });
          const htmlKey = aozoraFallbackChunkHtmlKey(jobId, chunkIndex);
          await this.env.XTC_BUCKET.put(htmlKey, chunkHtml, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
          });
          totalTextLength += dom.textLength;
          manifestChunks.push({
            index: chunkIndex,
            id: aozoraFallbackChunkId(chunkIndex),
            ...(chunkIndex === 0 ? { title: parsed.title } : {}),
            textLength: dom.textLength,
            elementCount: dom.elementCount,
            rubyCount: dom.rubyCount,
            brCount: dom.brCount,
            imageCount: dom.imageCount,
            htmlKey,
            pdfKey: aozoraFallbackChunkPdfKey(jobId, chunkIndex),
          });
        }

        const manifest: AozoraFallbackManifest = {
          version: 1,
          strategy: "four-balanced-dom-chunks",
          jobId,
          sourceUrl,
          title: parsed.title,
          author: parsed.byline,
          layout: options.layout,
          font: options.font,
          chunkCount: 4,
          totalTextLength,
          createdAt: convertedAt,
          chunks: manifestChunks,
        };
        const key = aozoraFallbackManifestKey(jobId);
        await this.env.XTC_BUCKET.put(key, serializeAozoraFallbackManifest(manifest), {
          httpMetadata: { contentType: "application/json" },
        });
        // Best-effort, diagnostic-only (src/aozora-fallback/progress.ts's
        // doc comment) — never awaited for its effect on the job outcome.
        await writeAozoraFallbackProgress(this.env, jobId, {
          phase: "splitting",
          completedChunks: 0,
        });
        return key;
      },
    );

    for (let index = 0; index < 4; index++) {
      const chunkIndex = index as AozoraFallbackChunkIndex;
      await step.do(
        `render-aozora-fallback-${aozoraFallbackChunkId(chunkIndex)}`,
        {
          // Same retry/timeout shape as render-pdf itself: a chunk is a
          // fraction of the original document, so the same worst-case
          // budget comfortably covers it.
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
          timeout: "7 minutes",
        },
        async () => {
          const htmlKey = aozoraFallbackChunkHtmlKey(jobId, chunkIndex);
          const chunkHtmlObj = await this.env.XTC_BUCKET.get(htmlKey);
          if (chunkHtmlObj === null) {
            // Only possible if the intermediate expired mid-job.
            throw new NonRetryableError(SPLIT_FAILED_MESSAGE);
          }
          const chunkHtml = await chunkHtmlObj.text();
          // The SAME shared fonts.css the initial (single-document) attempt
          // already produced — never regenerated per chunk (spec §27
          // "フォントCSSを4回生成しない"). Missing/unreadable degrades the
          // font only, same fail-soft stance as render-pdf's own fontsKey
          // handling above.
          let fontCss: string | null = null;
          if (fontsKey !== null) {
            try {
              const fonts = await this.env.XTC_BUCKET.get(fontsKey);
              fontCss = fonts !== null ? await fonts.text() : null;
            } catch (error) {
              console.error(`[${jobId}] R2 get ${fontsKey} failed`, error);
            }
          }
          const renderStart = Date.now();
          const response = await renderPdfFromHtml(this.env, chunkHtml, fontCss, options);
          const elapsedMs = Date.now() - renderStart;
          const browserMsHeader = response.headers.get("X-Browser-Ms-Used");
          const browserMsParsed = browserMsHeader !== null ? Number(browserMsHeader) : NaN;
          const browserMs = Number.isFinite(browserMsParsed) ? browserMsParsed : null;
          if (!response.ok) {
            const bodyText = await response.text();
            const code = parseBrowserRunErrorCode(bodyText);
            console.error(
              `[${jobId}] aozora fallback chunk ${chunkIndex} Browser Run returned ${response.status}: ${bodyText}`,
            );
            // Spec §16.3/§19 "MVPではretry後failed": a chunk hitting 6002
            // just uses this step's own (already-configured) retry budget,
            // same as every other render step — never a further split, never
            // extra retries beyond what render-aozora-fallback-* is already
            // configured with above.
            throw new Error(browserRunFallbackChunkErrorMessage(code));
          }
          const pdfBytes = new Uint8Array(await response.arrayBuffer());
          const maxPdfBytes = resolveMaxPdfBytes(this.env);
          if (pdfBytes.byteLength > maxPdfBytes) {
            throw new NonRetryableError(
              `rendered PDF exceeds the ${maxPdfBytes} byte limit; try a shorter page or the layout-preserving (full) mode`,
            );
          }
          const pageCount = await countPdfPages(pdfBytes).catch(() => null);
          console.log(`[${jobId}] aozora fallback render`, {
            chunkIndex,
            elapsedMs,
            browserMs,
            pdfBytes: pdfBytes.byteLength,
            pageCount,
          });
          await this.env.XTC_BUCKET.put(aozoraFallbackChunkPdfKey(jobId, chunkIndex), pdfBytes, {
            httpMetadata: { contentType: "application/pdf" },
          });
          await writeAozoraFallbackProgress(this.env, jobId, {
            phase: "rendering",
            completedChunks: chunkIndex + 1,
            currentChunkIndex: chunkIndex,
          });
        },
      );
    }

    return await step.do(
      "merge-aozora-fallback-pdf",
      {
        retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        timeout: "3 minutes",
      },
      async () => {
        const manifestObj = await this.env.XTC_BUCKET.get(manifestKey);
        if (manifestObj === null) {
          throw new NonRetryableError(MERGE_ERROR_FAILED);
        }
        const manifest = parseAozoraFallbackManifest(await manifestObj.text());
        if (manifest === null) {
          throw new NonRetryableError(MERGE_ERROR_FAILED);
        }

        const chunkBytes: Uint8Array[] = [];
        for (const chunk of manifest.chunks) {
          const obj = await this.env.XTC_BUCKET.get(chunk.pdfKey);
          if (obj === null) {
            throw new NonRetryableError(MERGE_ERROR_FAILED);
          }
          chunkBytes.push(new Uint8Array(await obj.arrayBuffer()));
        }

        const inputBytes = totalBytes(chunkBytes);
        if (inputBytes > MAX_FALLBACK_MERGE_INPUT_BYTES) {
          // Deterministic for this exact set of chunk PDFs.
          throw new NonRetryableError(MERGE_ERROR_TOO_LARGE);
        }

        const mergeStart = Date.now();
        // mergeChunkPdfs parses every chunk (and its own merged output)
        // exactly once and returns every page count this step needs —
        // deliberately NOT re-parsed here via countPdfPages: an unreadable
        // merged output already fails INSIDE mergeChunkPdfs (thrown as
        // MERGE_ERROR_FAILED/MERGE_ERROR_PAGE_MISMATCH below), so there is
        // no "outputPages couldn't be determined" case left to paper over
        // with a `.catch(() => -1)` that would silently defeat the
        // MAX_FALLBACK_MERGE_PAGES gate below.
        let merged: Uint8Array;
        let inputPageCounts: number[];
        let outputPages: number;
        try {
          ({ bytes: merged, inputPageCounts, outputPages } = await mergeChunkPdfs(chunkBytes));
        } catch (error) {
          // mergeChunkPdfs only ever throws one of the fixed spec §19
          // messages (MERGE_ERROR_FAILED / MERGE_ERROR_PAGE_MISMATCH) —
          // both deterministic for this exact set of chunk PDFs.
          const message = error instanceof Error ? error.message : MERGE_ERROR_FAILED;
          throw new NonRetryableError(message);
        }
        const elapsedMs = Date.now() - mergeStart;
        const inputPages = inputPageCounts.reduce((sum, n) => sum + n, 0);

        if (outputPages > MAX_FALLBACK_MERGE_PAGES) {
          throw new NonRetryableError(MERGE_ERROR_TOO_LARGE);
        }
        const maxPdfBytes = resolveMaxPdfBytes(this.env);
        if (merged.byteLength > maxPdfBytes) {
          throw new NonRetryableError(
            `rendered PDF exceeds the ${maxPdfBytes} byte limit; try a shorter page or the layout-preserving (full) mode`,
          );
        }

        console.log(`[${jobId}] aozora fallback PDF merge`, {
          inputPages,
          outputPages,
          inputBytes,
          outputBytes: merged.byteLength,
          compressionRatio: inputBytes > 0 ? merged.byteLength / inputBytes : null,
          elapsedMs,
        });

        const key = intermediatePdfKey(jobId);
        await this.env.XTC_BUCKET.put(key, merged, {
          httpMetadata: { contentType: "application/pdf" },
        });
        await writeAozoraFallbackProgress(this.env, jobId, {
          phase: "merging",
          completedChunks: 4,
        });
        return key;
      },
    );
  }

  /**
   * PDF-source pipeline (spec §9.2/§9.3): the uploaded PDF goes straight to
   * the Container's dedicated endpoint — no extract-content, no render-pdf
   * (there is nothing to render; the PDF already exists). Mirrors the
   * url-source convert-xtc step above (same retry/timeout shape, same
   * NonRetryable/retryable split), but calls
   * convertUploadedPdfInContainer(...) instead of convertInContainer(...)
   * and reads its input from inputPdfKey(jobId) instead of
   * intermediatePdfKey(jobId).
   */
  private async runUploadedPdf(
    jobId: string,
    source: Extract<ConvertSource, { kind: "pdf" }>,
    pdfOptions: PdfConvertOptions,
    step: WorkflowStep,
  ): Promise<{ xtcKey: string; title?: string }> {
    try {
      const { xtcKey, title } = await step.do(
        "convert-uploaded-pdf",
        {
          retries: { limit: 2, delay: "30 seconds", backoff: "constant" },
          // Same budget as the url-source convert-xtc step: xtctool may run
          // up to 600s.
          timeout: "12 minutes",
        },
        async () => {
          const input = await this.env.XTC_BUCKET.get(source.key);
          if (input === null) {
            // The upload came from the client, not something this Workflow
            // can regenerate — only possible if it expired or was deleted
            // mid-job.
            throw new NonRetryableError("uploaded PDF is missing");
          }
          let response: Response;
          try {
            // Stream R2 -> container (never buffer the whole PDF): same
            // FixedLengthStream requirement as convertInContainer, since the
            // container's http.server needs a Content-Length and rejects
            // chunked bodies.
            response = await convertUploadedPdfInContainer(
              this.env,
              jobId,
              input.body.pipeThrough(new FixedLengthStream(input.size)),
              pdfOptions,
              source.filename,
              CONVERTER_FETCH_TIMEOUT_MS,
            );
          } catch (error) {
            if (error instanceof DOMException && error.name === "TimeoutError") {
              throw new NonRetryableError(
                "XTC conversion timed out; the document is too large",
              );
            }
            throw error; // network/container failures stay retryable
          }
          if (!response.ok) {
            const bodyText = await response.text();
            console.error(`[${jobId}] converter returned ${response.status}: ${bodyText}`);
            if (response.status === 413) {
              throw new NonRetryableError(
                `uploaded PDF exceeds the ${resolveMaxUploadPdfBytes(this.env)} byte limit`,
              );
            }
            if (isNonRetryableUploadedPdfStatus(response.status)) {
              // Covers 400/415/422 (spec §9.4/§11.11): bad magic, unparseable,
              // encrypted, page-range/selection problems, bad config — all
              // deterministic for this exact input, so retrying would only
              // waste container time. uploadedPdfErrorMessage() reads the
              // Container's stable `code` field (converter/pdf_upload.py) to
              // pick a condition-specific message instead of the old
              // one-size-fits-all "invalid or unsupported PDF"; that string
              // is still the fallback when the code is missing/unrecognized.
              // Either way, only the mapped message — never Container detail
              // — reaches instance.status().error (src/jobs.ts).
              throw new NonRetryableError(uploadedPdfErrorMessage(bodyText));
            }
            // 500/503/other: xtctool failure, no free conversion slot, or an
            // internal error — left retryable like the url-source path.
            throw new Error("XTC conversion failed");
          }
          const { title } = await storeXtcOutput(this.env, jobId, response);
          return { xtcKey: outputXtcKey(jobId), title };
        },
      );

      return { xtcKey, title };
    } finally {
      // Runs on success and on terminal failure alike (spec §9.5) — the
      // input PDF is deleted either way. Best-effort: a delete failure here
      // still gets cleaned up by the input/ R2 lifecycle rule within a day
      // (claudedocs/pdf-upload-investigation.md §5.3).
      await step.do("delete-uploaded-pdf", async () => {
        try {
          await this.env.XTC_BUCKET.delete(source.key);
        } catch (error) {
          console.error(`[${jobId}] best-effort delete of ${source.key} failed`, error);
        }
      });
    }
  }

  /**
   * TXT-upload pipeline (text-upload spec §12.2-§12.6): prepare-text
   * (decode/validate/normalize/build the reading HTML + font CSS) ->
   * render-text-pdf (renderSelfStyledHtmlPdf, src/pdf.ts — deliberately NOT
   * renderPdfFromHtml, see that function's doc comment) -> convert-xtc
   * (reuses the same trusted /convert Container endpoint the URL pipeline
   * uses, since the rendered PDF is one this service produced itself) ->
   * delete-text-intermediates (all four R2 objects, success or failure
   * alike, spec §12.6).
   *
   * Each step re-reads its input from R2 so a retry never depends on
   * in-memory state from a prior attempt, matching every other pipeline in
   * this Workflow. Step return values never carry the TXT body itself (spec
   * §12.3) — only R2 keys and small counts.
   */
  private async runTextSource(
    jobId: string,
    source: Extract<ConvertSource, { kind: "text" }>,
    textOptions: TextConvertOptions,
    step: WorkflowStep,
  ): Promise<{ xtcKey: string; title?: string }> {
    let articleKey: string | null = null;
    let fontsKey: string | null = null;
    let pdfKey: string | null = null;
    // Resolved by prepare-text (prepareTextDocument's extracted/aozora-header
    // author, or the explicit textOptions.author when neither is present —
    // see prepareTextDocument's resolveDisplayValue priority chain) and
    // forwarded to convert-xtc's convertInContainer call so an aozora
    // document's header-extracted author reaches the XTC metadata, not just
    // whatever textOptions.author the client happened to submit.
    let resolvedAuthor: string | undefined;

    try {
      ({ articleKey, fontsKey, resolvedAuthor } = await step.do(
        "prepare-text",
        {
          // No retry budget beyond one extra attempt: every failure this step
          // can produce (bad encoding, binary input, over the char/line/HTML
          // limits) is deterministic for this exact upload — see the
          // NonRetryableError throws below, which skip retries entirely. The
          // single retry only covers a transient R2 get/put hiccup.
          retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
          // Covers the R2 round trip plus buildInlineFontCss's font-fetch
          // fan-out (up to 8 css2 + N woff2 fetches at 10s each, run in
          // parallel — src/fonts.ts), mirroring extract-content's budget for
          // the same reason.
          timeout: "3 minutes",
        },
        async () => {
          const input = await this.env.XTC_BUCKET.get(source.key);
          if (input === null) {
            // Only possible if the upload expired or was deleted mid-job.
            throw new NonRetryableError("uploaded text file is missing");
          }
          if (input.size > MAX_TEXT_FILE_BYTES) {
            // Defense in depth: the Worker already enforced this at upload
            // time (spec §11.3); a stale/tampered object should never reach
            // decoding.
            throw new NonRetryableError(textPrepareErrorMessage(new TextTooLongError("upload too large")));
          }
          const bytes = new Uint8Array(await input.arrayBuffer());

          let decoded;
          try {
            decoded = decodeTextFile(bytes, textOptions.encoding);
          } catch (error) {
            throw new NonRetryableError(textPrepareErrorMessage(error));
          }

          try {
            validateTextLimits(decoded.text);
          } catch (error) {
            throw new NonRetryableError(textPrepareErrorMessage(error));
          }

          // Single shared preparation entrypoint (aozora-text-conversion spec
          // §6.3/§13.1-§13.3): branches on textOptions.inputFormat internally
          // and produces byte-identical `plain` output to the pre-existing
          // normalizeText -> resolveDocumentTitle -> buildTextArticleHtml
          // sequence this replaced (test/text-prepare.test.ts's parity pin).
          // src/preview/text-preview.ts calls the exact same function so
          // production and the X3 preview can never diverge in how a TXT
          // body becomes reading HTML (spec §14.1).
          let prepared;
          try {
            prepared = prepareTextDocument({
              decodedText: decoded.text,
              filename: source.filename,
              options: textOptions,
            });
          } catch (error) {
            if (error instanceof AozoraAstLimitExceededError) {
              // Deterministic for this exact input (spec §17's "AST全体上限
              // 超過は決定的エラー") — retrying would re-parse the same
              // oversized document. The thrown error's own message already
              // holds no document content (AozoraAstLimitExceededError's own
              // doc comment), and textPrepareErrorMessage falls through to
              // its generic message for an error type it doesn't
              // specifically recognize, so nothing body-derived reaches the
              // job's stored error string either.
              throw new NonRetryableError(textPrepareErrorMessage(error));
            }
            // Every other error prepareTextDocument can throw (TextTooLongError
            // etc., surfaced via normalizeText/normalizeForAozora) maps the
            // same way it always has.
            throw new NonRetryableError(textPrepareErrorMessage(error));
          }

          // The removed characters themselves are never logged (spec §8.3/§17) —
          // only the count. Same for every other prepare-text diagnostic below:
          // counts only, never body/title/author/generated-HTML content.
          if (prepared.controlCharsRemoved > 0) {
            console.log(
              `[${jobId}] text: stripped ${prepared.controlCharsRemoved} control character(s)`,
            );
          }
          console.log(
            `[${jobId}] text: inputFormat=${textOptions.inputFormat} chars=${prepared.characterCount} lines=${prepared.lineCount} ` +
              `recognizedAnnotations=${prepared.diagnostics.recognizedAnnotations} ` +
              `unsupportedAnnotations=${prepared.diagnostics.unsupportedAnnotations} ` +
              `malformedAnnotations=${prepared.diagnostics.malformedAnnotations}`,
          );

          const htmlBytes = new TextEncoder().encode(prepared.html);
          if (htmlBytes.byteLength > MAX_GENERATED_HTML_BYTES) {
            // Deterministic for this input+options combination — retrying
            // would regenerate the same oversized HTML.
            throw new NonRetryableError(
              textPrepareErrorMessage(new TextTooLongError("generated HTML too large")),
            );
          }

          const key = articleHtmlKey(jobId);
          await this.env.XTC_BUCKET.put(key, htmlBytes, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
          });

          // Font inlining is fail-soft (src/fonts.ts): a missing/failed web
          // font degrades to the article's own generic font-family fallback
          // (baked into buildTextPrintCss), never fails the job. The subset
          // covers every string that lands in the document — title, author,
          // and body (prepared.searchableText already folds in the aozora
          // AST's rendered plain text, or the normalized plain-text body,
          // per prepareTextDocument's branch) — so a title/author that uses
          // characters absent from the body still gets a matching glyph.
          const fontSubsetText = `${prepared.documentTitle}\n${textOptions.title}\n${textOptions.author}\n${prepared.searchableText}`;
          const fontCss = await buildInlineFontCss(fontSubsetText, jobId, fetch, textOptions.font);
          let storedFontsKey: string | null = null;
          if (fontCss !== null) {
            const fKey = fontsCssKey(jobId);
            try {
              await this.env.XTC_BUCKET.put(fKey, fontCss, {
                httpMetadata: { contentType: "text/css; charset=utf-8" },
              });
              storedFontsKey = fKey;
            } catch (error) {
              console.error(
                `[${jobId}] R2 put ${fKey} failed; rendering without the inline font`,
                error,
              );
            }
          }

          return {
            articleKey: key,
            fontsKey: storedFontsKey,
            detectedEncoding: decoded.encoding,
            resolvedAuthor: prepared.author,
            characterCount: prepared.characterCount,
            lineCount: prepared.lineCount,
            diagnostics: prepared.diagnostics,
          };
        },
      ));

      ({ pdfKey } = await step.do(
        "render-text-pdf",
        {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
          // Same budget as the URL pipeline's render-pdf step: goto/font
          // grace + the 300s pdf-generation cap in pdf.ts, plus R2 I/O margin.
          timeout: "7 minutes",
        },
        async () => {
          if (articleKey === null) {
            // Unreachable in practice (prepare-text always returns a key on
            // success or throws), but keeps this step's input contract
            // explicit and satisfies strict null checking.
            throw new NonRetryableError("prepared article HTML is missing");
          }
          const article = await this.env.XTC_BUCKET.get(articleKey);
          if (article === null) {
            // Only possible if the intermediate expired mid-job.
            throw new NonRetryableError("prepared article HTML is missing");
          }
          let fontCss: string | null = null;
          if (fontsKey !== null) {
            try {
              const fonts = await this.env.XTC_BUCKET.get(fontsKey);
              fontCss = fonts !== null ? await fonts.text() : null;
            } catch (error) {
              console.error(`[${jobId}] R2 get ${fontsKey} failed`, error);
            }
          }

          const articleHtml = await article.text();
          const articleBytes = new TextEncoder().encode(articleHtml).length;
          const fontCssBytes =
            fontCss !== null ? new TextEncoder().encode(fontCss).length : 0;
          const renderStart = Date.now();
          const response = await renderSelfStyledHtmlPdf(
            this.env,
            articleHtml,
            fontCss,
          );
          const elapsedMs = Date.now() - renderStart;
          // See render-pdf's comment: X-Browser-Ms-Used is Quick Actions'
          // reported browser-time consumption for the request; the
          // isFinite guard keeps an empty/non-numeric header from reading
          // as a false "0ms"/NaN measurement.
          const browserMsHeader = response.headers.get("X-Browser-Ms-Used");
          const browserMsParsed =
            browserMsHeader !== null ? Number(browserMsHeader) : NaN;
          // See render-pdf's identical comment: the body can only be read
          // once, so it is read here (failure only) ahead of the log line.
          let browserRunErrorBody: string | null = null;
          let browserRunErrorCode: number | null = null;
          if (!response.ok) {
            browserRunErrorBody = await response.text();
            browserRunErrorCode = parseBrowserRunErrorCode(browserRunErrorBody);
          }
          console.log(`[${jobId}] render-text-pdf`, {
            ok: response.ok,
            status: response.status,
            elapsedMs,
            browserMs: Number.isFinite(browserMsParsed) ? browserMsParsed : null,
            articleBytes,
            fontCssBytes,
            code: browserRunErrorCode,
          });
          if (!response.ok) {
            console.error(
              `[${jobId}] Browser Run returned ${response.status}: ${browserRunErrorBody}`,
            );
            throw new Error(browserRunPdfErrorMessage(browserRunErrorCode));
          }
          const pdfBytes = await response.arrayBuffer();
          const maxPdfBytes = resolveMaxPdfBytes(this.env);
          if (pdfBytes.byteLength > maxPdfBytes) {
            // Deterministic: retrying would render the same PDF.
            throw new NonRetryableError(
              `rendered PDF exceeds the ${maxPdfBytes} byte limit; reduce the font size or margins`,
            );
          }
          const key = intermediatePdfKey(jobId);
          await this.env.XTC_BUCKET.put(key, pdfBytes, {
            httpMetadata: { contentType: "application/pdf" },
          });
          return { pdfKey: key };
        },
      ));

      const { xtcKey, title } = await step.do(
        "convert-xtc",
        {
          retries: { limit: 2, delay: "30 seconds", backoff: "constant" },
          timeout: "12 minutes",
        },
        async () => {
          if (pdfKey === null) {
            throw new NonRetryableError("intermediate PDF is missing");
          }
          const pdfSource = await this.env.XTC_BUCKET.get(pdfKey);
          if (pdfSource === null) {
            throw new NonRetryableError("intermediate PDF is missing");
          }
          let response: Response;
          try {
            // Same trusted /convert endpoint + FixedLengthStream requirement
            // as the URL pipeline's convert-xtc step — this PDF was rendered
            // by this service's own Browser Run call above, not uploaded by
            // the client. resolvedAuthor (prepare-text's prepared.author)
            // rides along as X-Xtc-Author (src/container.ts): the only
            // /convert caller that ever has an author to set, since the
            // title alone travels via the PDF's own metadata
            // (document.title -> Chromium print -> read_pdf_metadata).
            // resolvedAuthor is prepareTextDocument's resolveDisplayValue
            // priority chain (spec §8.2) — an aozora document's own
            // extracted 著者 header when textOptions.author was left blank,
            // not just whatever the client explicitly submitted.
            response = await convertInContainer(
              this.env,
              jobId,
              pdfSource.body.pipeThrough(new FixedLengthStream(pdfSource.size)),
              CONVERTER_FETCH_TIMEOUT_MS,
              resolvedAuthor,
            );
          } catch (error) {
            if (error instanceof DOMException && error.name === "TimeoutError") {
              throw new NonRetryableError(
                "XTC conversion timed out; the document is too large",
              );
            }
            throw error; // network/container failures stay retryable
          }
          if (!response.ok) {
            console.error(
              `[${jobId}] converter returned ${response.status}: ${await response.text()}`,
            );
            if (response.status === 413) {
              throw new NonRetryableError(
                `rendered PDF exceeds the ${resolveMaxPdfBytes(this.env)} byte limit; reduce the font size or margins`,
              );
            }
            throw new Error("XTC conversion failed");
          }
          const { title } = await storeXtcOutput(this.env, jobId, response);
          return { xtcKey: outputXtcKey(jobId), title };
        },
      );

      return { xtcKey, title };
    } finally {
      // Runs on success and on terminal failure alike (spec §12.6): every
      // input/intermediate object this pipeline produced is removed, not
      // just the uploaded TXT. Best-effort — a delete failure here still
      // gets cleaned up by the input//intermediate/ R2 lifecycle rules
      // within a day.
      await step.do("delete-text-intermediates", async () => {
        const keys = [source.key, articleKey, fontsKey, pdfKey].filter(
          (key): key is string => key !== null,
        );
        for (const key of keys) {
          try {
            await this.env.XTC_BUCKET.delete(key);
          } catch (error) {
            console.error(`[${jobId}] best-effort delete of ${key} failed`, error);
          }
        }
      });
    }
  }

  /**
   * EPUB-upload pipeline (EPUB_TO_XTC_IMPLEMENTATION_SPEC.md §14): prepare-epub
   * (re-fetch + re-verify size, parse+sanitize the archive via
   * prepareEpubDocument — the single Phase 3 entrypoint — build the inline
   * font CSS) -> render-epub-pdf (renderSelfStyledHtmlPdf, same as the TXT
   * pipeline's render-text-pdf — deliberately NOT renderPdfFromHtml, see that
   * function's doc comment in src/pdf.ts) -> convert-xtc (reuses the same
   * trusted /convert Container endpoint the URL/TXT pipelines use, since the
   * rendered PDF is one this service produced itself) ->
   * delete-epub-intermediates (all four R2 objects, success or failure
   * alike, spec §14.1.4).
   *
   * Mirrors runTextSource's structure deliberately (design decision D12):
   * same step pair for prepare/render, same font-CSS handoff via its own R2
   * key, same convert-xtc/cleanup shape. Title reaches the XTC via the
   * existing HTML-<title> -> Chromium PDF metadata -> converter/app.py
   * read-back path (prepareEpubDocument already writes the EPUB's title into
   * the generated HTML's <title>) — convertInContainer's request-header
   * surface is deliberately left untouched (only `author` travels that way,
   * exactly as it already does for TXT) so as not to collide with the
   * existing X-Xtc-Title *response* header src/jobs.ts#decodeTitleHeader
   * reads (design decision D1).
   *
   * Step outputs never carry the EPUB body or the generated HTML (spec
   * §14.1.1/§22) — only R2 keys, small counts, and warning codes.
   */
  private async runEpubSource(
    jobId: string,
    source: Extract<ConvertSource, { kind: "epub" }>,
    epubOptions: EpubConvertOptions,
    step: WorkflowStep,
  ): Promise<{ xtcKey: string; title?: string }> {
    let articleKey: string | null = null;
    let fontsKey: string | null = null;
    let pdfKey: string | null = null;
    // Resolved by prepare-epub (prepareEpubDocument's OPF dc:creator) and
    // forwarded to convert-xtc's convertInContainer call, exactly like
    // runTextSource's resolvedAuthor — the only other /convert caller with
    // an author to set, since the title alone travels via the PDF's own
    // metadata (document.title -> Chromium print -> read_pdf_metadata).
    let resolvedAuthor: string | undefined;

    try {
      ({ articleKey, fontsKey, author: resolvedAuthor } = await step.do(
        "prepare-epub",
        {
          // No retry budget beyond one extra attempt: every failure
          // prepareEpubDocument can produce (malformed archive, encrypted,
          // fixed layout, empty spine, oversized) is deterministic for this
          // exact upload — see the EpubError.deterministic branch below,
          // which skips retries entirely via NonRetryableError. The single
          // retry only covers a transient R2 get/put or font-fetch hiccup.
          retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
          // Covers the R2 round trip, ZIP parsing, and
          // buildInlineFontCss's font-fetch fan-out (up to 8 css2 + N woff2
          // fetches at 10s each, run in parallel — src/fonts.ts), mirroring
          // prepare-text's budget for the same reason.
          timeout: "3 minutes",
        },
        async () => {
          const input = await this.env.XTC_BUCKET.get(source.key);
          if (input === null) {
            // Only possible if the upload expired or was deleted mid-job.
            throw new NonRetryableError("uploaded EPUB is missing");
          }
          // Defense in depth (design decision D13): the Worker already
          // enforced this at upload time (spec §7.3/§18's "Content-Length
          // と保存サイズを照合する"); a stale/tampered R2 object should
          // never reach ZIP parsing. Mirrors prepare-text's identical
          // re-check against MAX_TEXT_FILE_BYTES.
          const maxUploadBytes = resolveMaxUploadEpubBytes(this.env);
          if (input.size > maxUploadBytes) {
            throw new NonRetryableError(
              `uploaded EPUB exceeds the ${maxUploadBytes} byte limit`,
            );
          }

          const bytes = new Uint8Array(await input.arrayBuffer());

          let prepared;
          try {
            prepared = prepareEpubDocument(bytes, epubOptions, {
              filename: source.filename,
              limits: {
                maxEntries: resolveMaxEpubEntries(this.env),
                maxEntryBytes: resolveMaxEpubEntryBytes(this.env),
                maxTotalUncompressedBytes: resolveMaxEpubUncompressedBytes(this.env),
                maxHtmlBytes: resolveMaxEpubHtmlBytes(this.env),
              },
            });
          } catch (error) {
            if (error instanceof EpubError) {
              // errors.ts's DETERMINISTIC_ERROR_CODES allowlist is the
              // authority here: every code it currently defines describes a
              // property of the uploaded bytes, but the flag is checked
              // explicitly (not assumed) so a future code that ISN'T added
              // to that allowlist fails safe as retryable instead of
              // silently swallowing a real platform hiccup.
              if (error.deterministic) {
                throw new NonRetryableError(error.clientMessage);
              }
              throw new Error(error.clientMessage);
            }
            throw error; // unexpected — stays retryable
          }

          // Structural warning codes only (never EPUB paths/text — spec
          // §14.1.1/§17): every code prepareEpubDocument currently emits
          // (SPINE_ITEM_MISSING, CHAPTER_UNPARSEABLE, COVER_DUPLICATE_SKIPPED)
          // carries no `detail`.
          if (prepared.warnings.length > 0) {
            console.log(
              `[${jobId}] epub: warnings=${prepared.warnings.map((w) => w.code).join(",")}`,
            );
          }

          const key = epubHtmlKey(jobId);
          await this.env.XTC_BUCKET.put(key, prepared.html, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
          });

          // Font inlining is fail-soft (src/fonts.ts): a missing/failed web
          // font degrades to the generated HTML's own font-family fallback
          // baked into buildFinalCss, never fails the job. The whole
          // generated HTML is passed as the subset-text source per
          // prepareEpubDocument's own doc comment (design decision D12) —
          // intentional over-inclusion, matching src/fonts.ts's stance.
          const fontCss = await buildInlineFontCss(prepared.html, jobId, fetch, epubOptions.font);
          let storedFontsKey: string | null = null;
          if (fontCss !== null) {
            const fKey = epubFontsCssKey(jobId);
            try {
              await this.env.XTC_BUCKET.put(fKey, fontCss, {
                httpMetadata: { contentType: "text/css; charset=utf-8" },
              });
              storedFontsKey = fKey;
            } catch (error) {
              console.error(
                `[${jobId}] R2 put ${fKey} failed; rendering without the inline font`,
                error,
              );
            }
          }

          return {
            articleKey: key,
            fontsKey: storedFontsKey,
            title: prepared.title,
            author: prepared.author,
            layout: prepared.layout,
            spineItemCount: prepared.spineItemCount,
            warnings: prepared.warnings.map((w) => w.code),
          };
        },
      ));

      ({ pdfKey } = await step.do(
        "render-epub-pdf",
        {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
          // Same budget as render-text-pdf: goto/font grace + the 300s
          // pdf-generation cap in pdf.ts, plus R2 I/O margin.
          timeout: "7 minutes",
        },
        async () => {
          if (articleKey === null) {
            // Unreachable in practice (prepare-epub always returns a key on
            // success or throws), but keeps this step's input contract
            // explicit and satisfies strict null checking.
            throw new NonRetryableError("prepared EPUB HTML is missing");
          }
          const article = await this.env.XTC_BUCKET.get(articleKey);
          if (article === null) {
            // Only possible if the intermediate expired mid-job.
            throw new NonRetryableError("prepared EPUB HTML is missing");
          }
          let fontCss: string | null = null;
          if (fontsKey !== null) {
            try {
              const fonts = await this.env.XTC_BUCKET.get(fontsKey);
              fontCss = fonts !== null ? await fonts.text() : null;
            } catch (error) {
              console.error(`[${jobId}] R2 get ${fontsKey} failed`, error);
            }
          }

          const articleHtml = await article.text();
          const articleBytes = new TextEncoder().encode(articleHtml).length;
          const fontCssBytes =
            fontCss !== null ? new TextEncoder().encode(fontCss).length : 0;
          const renderStart = Date.now();
          const response = await renderSelfStyledHtmlPdf(
            this.env,
            articleHtml,
            fontCss,
          );
          const elapsedMs = Date.now() - renderStart;
          // See render-pdf's comment: X-Browser-Ms-Used is Quick Actions'
          // reported browser-time consumption for the request; the
          // isFinite guard keeps an empty/non-numeric header from reading
          // as a false "0ms"/NaN measurement.
          const browserMsHeader = response.headers.get("X-Browser-Ms-Used");
          const browserMsParsed =
            browserMsHeader !== null ? Number(browserMsHeader) : NaN;
          // See render-pdf's identical comment: the body can only be read
          // once, so it is read here (failure only) ahead of the log line.
          let browserRunErrorBody: string | null = null;
          let browserRunErrorCode: number | null = null;
          if (!response.ok) {
            browserRunErrorBody = await response.text();
            browserRunErrorCode = parseBrowserRunErrorCode(browserRunErrorBody);
          }
          console.log(`[${jobId}] render-epub-pdf`, {
            ok: response.ok,
            status: response.status,
            elapsedMs,
            browserMs: Number.isFinite(browserMsParsed) ? browserMsParsed : null,
            articleBytes,
            fontCssBytes,
            code: browserRunErrorCode,
          });
          if (!response.ok) {
            console.error(
              `[${jobId}] Browser Run returned ${response.status}: ${browserRunErrorBody}`,
            );
            throw new Error(browserRunPdfErrorMessage(browserRunErrorCode));
          }
          const pdfBytes = await response.arrayBuffer();
          const maxPdfBytes = resolveMaxPdfBytes(this.env);
          if (pdfBytes.byteLength > maxPdfBytes) {
            // Deterministic: retrying would render the same PDF.
            throw new NonRetryableError(
              `rendered PDF exceeds the ${maxPdfBytes} byte limit; try a smaller font size or fewer chapters`,
            );
          }
          const key = intermediatePdfKey(jobId);
          await this.env.XTC_BUCKET.put(key, pdfBytes, {
            httpMetadata: { contentType: "application/pdf" },
          });
          return { pdfKey: key };
        },
      ));

      const { xtcKey, title } = await step.do(
        "convert-xtc",
        {
          retries: { limit: 2, delay: "30 seconds", backoff: "constant" },
          timeout: "12 minutes",
        },
        async () => {
          if (pdfKey === null) {
            throw new NonRetryableError("intermediate PDF is missing");
          }
          const pdfSource = await this.env.XTC_BUCKET.get(pdfKey);
          if (pdfSource === null) {
            throw new NonRetryableError("intermediate PDF is missing");
          }
          let response: Response;
          try {
            // Same trusted /convert endpoint + FixedLengthStream requirement
            // as the URL/TXT pipelines' convert-xtc step — this PDF was
            // rendered by this service's own Browser Run call above, not
            // uploaded by the client. resolvedAuthor (prepare-epub's
            // prepared.author, the OPF dc:creator) rides along as
            // X-Xtc-Author (src/container.ts), same as the TXT pipeline.
            response = await convertInContainer(
              this.env,
              jobId,
              pdfSource.body.pipeThrough(new FixedLengthStream(pdfSource.size)),
              CONVERTER_FETCH_TIMEOUT_MS,
              resolvedAuthor,
            );
          } catch (error) {
            if (error instanceof DOMException && error.name === "TimeoutError") {
              throw new NonRetryableError(
                "XTC conversion timed out; the document is too large",
              );
            }
            throw error; // network/container failures stay retryable
          }
          if (!response.ok) {
            console.error(
              `[${jobId}] converter returned ${response.status}: ${await response.text()}`,
            );
            if (response.status === 413) {
              throw new NonRetryableError(
                `rendered PDF exceeds the ${resolveMaxPdfBytes(this.env)} byte limit; try a smaller font size or fewer chapters`,
              );
            }
            throw new Error("XTC conversion failed");
          }
          const { title } = await storeXtcOutput(this.env, jobId, response);
          return { xtcKey: outputXtcKey(jobId), title };
        },
      );

      return { xtcKey, title };
    } finally {
      // Runs on success and on terminal failure alike (spec §14.1.4): every
      // input/intermediate object this pipeline produced is removed, not
      // just the uploaded EPUB. Best-effort — a delete failure here still
      // gets cleaned up by the input//intermediate/ R2 lifecycle rules
      // within a day.
      await step.do("delete-epub-intermediates", async () => {
        const keys = [source.key, articleKey, fontsKey, pdfKey].filter(
          (key): key is string => key !== null,
        );
        for (const key of keys) {
          try {
            await this.env.XTC_BUCKET.delete(key);
          } catch (error) {
            console.error(`[${jobId}] best-effort delete of ${key} failed`, error);
          }
        }
      });
    }
  }
}
