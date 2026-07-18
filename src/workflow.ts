// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { convertInContainer } from "./container";
import { intermediatePdfKey, outputXtcKey, resolveMaxPdfBytes } from "./jobs";
import { renderPdf } from "./pdf";
import { storeXtcOutput } from "./pipeline";
import type { ConvertJobParams, Env } from "./types";

// xtctool may run up to 600s (XTC_TIMEOUT_SECONDS in container.ts); allow a
// 30s margin for transfer and container startup. Must stay below the step
// timeout ("12 minutes") or the fetch would never get to time out itself.
const CONVERTER_FETCH_TIMEOUT_MS = 630_000;

/**
 * Three-step conversion pipeline behind POST /jobs (render-pdf → convert-xtc
 * → delete-intermediate-pdf). The instance ID doubles as
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

    const { pdfKey } = await step.do(
      "render-pdf",
      {
        retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        // Must cover a worst-case legitimate render: goto cap (60s) + pdf
        // generation cap (300s) in pdf.ts, plus margin for R2 I/O.
        timeout: "7 minutes",
      },
      async () => {
        const response = await renderPdf(this.env, url);
        if (!response.ok) {
          // Upstream detail goes to logs only; the thrown message surfaces
          // to the client via instance.status().error on final failure.
          console.error(
            `[${jobId}] Browser Run returned ${response.status}: ${await response.text()}`,
          );
          throw new Error("PDF generation failed");
        }
        const pdfBytes = await response.arrayBuffer();
        const maxPdfBytes = resolveMaxPdfBytes(this.env);
        if (pdfBytes.byteLength > maxPdfBytes) {
          // Deterministic failure: retrying would render the same PDF.
          throw new NonRetryableError(
            `rendered PDF exceeds the ${maxPdfBytes} byte limit; try a shorter page`,
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
            response = await convertInContainer(
              this.env,
              jobId,
              await source.arrayBuffer(),
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
                `rendered PDF exceeds the ${resolveMaxPdfBytes(this.env)} byte limit; try a shorter page`,
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
        try {
          await this.env.XTC_BUCKET.delete(pdfKey);
        } catch (error) {
          console.error(`[${jobId}] best-effort delete of ${pdfKey} failed`, error);
        }
      });
    }
  }
}
