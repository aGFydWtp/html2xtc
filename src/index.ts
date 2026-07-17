import { authorize } from "./auth";
import { convertInContainer } from "./container";
import {
  decideMissingDownload,
  decodeTitleHeader,
  intermediatePdfKey,
  mapInstanceStatus,
  needsPhaseProbe,
  outputXtcKey,
  resolveMaxPdfBytes,
  xtcContentDisposition,
} from "./jobs";
import { renderPdf } from "./pdf";
import type { Env } from "./types";
import { UrlValidationError, validatePublicUrl } from "./validate";

export { XtcConverterContainer } from "./container";
export { ConvertWorkflow } from "./workflow";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Sync-path budget for the container fetch. Deliberately short: /convert is
// for short pages; long documents go through /jobs, where the Workflow
// allows the full 600s xtctool run (see src/workflow.ts).
const SYNC_CONVERTER_FETCH_TIMEOUT_MS = 150_000;

export default {
  async fetch(request, env) {
    // Whatever fails below, the client always gets an {error} JSON.
    try {
      return await route(request, env);
    } catch (error) {
      console.error("unhandled error", error);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  // Access JWT or Bearer AUTH_TOKEN (see src/auth.ts). Static assets in
  // public/ are served before the Worker and never reach this check; they
  // are protected by the edge-side Cloudflare Access app instead.
  const unauthorized = await authorize(request, env);
  if (unauthorized) {
    return unauthorized;
  }

  const { pathname } = new URL(request.url);

  if (pathname === "/convert") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    return handleConvert(request, env);
  }

  if (pathname === "/jobs") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    return handleCreateJob(request, env);
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

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { Allow: allow } },
  );
}

/**
 * Parses the {url} request body and runs SSRF validation.
 * Returns the validated URL, or the error Response to send as-is.
 */
async function readTargetUrl(request: Request): Promise<URL | Response> {
  let url: string | undefined;
  try {
    ({ url } = await request.json<{ url?: string }>());
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }
  if (typeof url !== "string" || url.length === 0) {
    return Response.json({ error: "url is required" }, { status: 400 });
  }

  try {
    return await validatePublicUrl(url);
  } catch (error) {
    if (error instanceof UrlValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

async function handleCreateJob(request: Request, env: Env): Promise<Response> {
  const target = await readTargetUrl(request);
  if (target instanceof Response) {
    return target;
  }

  const jobId = crypto.randomUUID();
  try {
    await env.CONVERT_WORKFLOW.create({
      id: jobId,
      params: { url: target.toString() },
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

async function handleJobStatus(jobId: string, env: Env): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) {
    return Response.json({ error: "jobId must be a UUID" }, { status: 400 });
  }

  let instance: WorkflowInstance;
  try {
    instance = await env.CONVERT_WORKFLOW.get(jobId);
  } catch {
    // Unknown ID or past the 30-day retention window. Note: a transient
    // platform error in get() also lands here as 404; pollers will see the
    // real status again on the next request.
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
 * Maps an instance status to the API body; for the running family this
 * probes R2 for the intermediate PDF to tell rendering from converting.
 */
async function mapWithPhaseProbe(
  jobId: string,
  status: InstanceStatus,
  env: Env,
) {
  const hasIntermediatePdf = needsPhaseProbe(status.status)
    ? (await env.XTC_BUCKET.head(intermediatePdfKey(jobId))) !== null
    : false;
  return mapInstanceStatus(jobId, status, hasIntermediatePdf);
}

async function handleConvert(request: Request, env: Env): Promise<Response> {
  const target = await readTargetUrl(request);
  if (target instanceof Response) {
    return target;
  }

  const jobId = crypto.randomUUID();

  let pdfResponse: Response;
  try {
    pdfResponse = await renderPdf(env, target.toString());
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
        error: `rendered PDF exceeds the ${maxPdfBytes} byte limit; try a shorter page`,
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

  if (convertResult.status === "rejected") {
    console.error(`[${jobId}] converter fetch failed`, convertResult.reason);
    await deleteBestEffort(env, pdfKey);
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
    await deleteBestEffort(env, pdfKey);
    return Response.json({ error: "XTC conversion failed", jobId }, { status: 422 });
  }

  // Page title extracted from the PDF by converter/app.py; best-effort.
  const title = decodeTitleHeader(converterResponse.headers.get("X-Xtc-Title"));
  const xtcBytes = await converterResponse.arrayBuffer();
  try {
    await env.XTC_BUCKET.put(outputXtcKey(jobId), xtcBytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      // The download handler reads the title back from here for the
      // Content-Disposition filename.
      customMetadata: title !== undefined ? { title } : undefined,
    });
  } catch (error) {
    console.error(`[${jobId}] R2 put output.xtc failed`, error);
    return Response.json({ error: "storage error", jobId }, { status: 500 });
  }

  return Response.json({
    jobId,
    downloadUrl: `/download/${jobId}`,
    ...(title !== undefined ? { title } : {}),
  });
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
