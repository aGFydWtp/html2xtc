import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "./types";

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
const CONVERTER_POOL_SIZE = 2;

/**
 * Sends the PDF to the converter container and returns its response.
 * timeoutMs bounds the whole fetch: the sync /convert path passes a short
 * budget, the Workflow passes one sized for the 600s xtctool limit.
 */
export function convertInContainer(
  env: Env,
  jobId: string,
  pdfBytes: ArrayBuffer,
  timeoutMs: number,
): Promise<Response> {
  const container = getContainer(env.XTC_CONVERTER, converterInstanceName(jobId));
  return container.fetch(
    new Request("http://converter/convert", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBytes,
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
