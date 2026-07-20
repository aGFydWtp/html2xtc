// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { convertInContainer } from "./container";
import { prepareRenderInput } from "./extract";
import {
  articleHtmlKey,
  fontsCssKey,
  intermediatePdfKey,
  outputXtcKey,
  resolveMaxPdfBytes,
} from "./jobs";
import { renderPdf, renderPdfFromHtml } from "./pdf";
import { storeXtcOutput } from "./pipeline";
import type { ConvertJobParams, Env } from "./types";

// xtctool may run up to 600s (XTC_TIMEOUT_SECONDS in container.ts); allow a
// 30s margin for transfer and container startup. Must stay below the step
// timeout ("12 minutes") or the fetch would never get to time out itself.
const CONVERTER_FETCH_TIMEOUT_MS = 630_000;

/**
 * Conversion pipeline behind POST /jobs (extract mode only: extract-content
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
    const { url } = event.payload;
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
    if (mode === "extract") {
      ({ articleKey, fontsKey } = await step.do(
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
          );
          if (input.kind === "url") {
            return { articleKey: null, fontsKey: null };
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
            return { articleKey: null, fontsKey: null };
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
          return { articleKey: key, fontsKey: storedFontsKey };
        },
      ));
    }

    const { pdfKey } = await step.do(
      "render-pdf",
      {
        retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        // Must cover a worst-case legitimate render: goto cap (60s) + fixed
        // lazy-image/font grace (10s, PDF_FULL_WAIT_MS) + pdf generation cap
        // (300s) in pdf.ts, plus margin for R2 I/O.
        timeout: "7 minutes",
      },
      async () => {
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
        if (article !== null) {
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
          response = await renderPdfFromHtml(
            this.env,
            await article.text(),
            fontCss,
          );
        } else {
          response = await renderPdf(this.env, url);
        }
        if (!response.ok) {
          // Upstream detail goes to logs only; the thrown message surfaces
          // to the client via instance.status().error on final failure.
          console.error(
            `[${jobId}] Browser Run returned ${response.status}: ${await response.text()}`,
          );
          throw new Error("PDF generation failed");
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
        return { pdfKey: key };
      },
    );

    try {
      const { xtcKey, title } = await step.do(
        "convert-xtc",
        {
          retries: { limit: 2, delay: "30 seconds", backoff: "constant" },
          // Explicit: the default step timeout (10 minutes per attempt) is too
          // tight for a conversion that may itself take up to 10 minutes.
          timeout: "12 minutes",
        },
        async () => {
          const source = await this.env.XTC_BUCKET.get(pdfKey);
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
        const keys = [pdfKey, articleKey, fontsKey].filter(
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
