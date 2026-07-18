import { decodeTitleHeader, outputXtcKey } from "./jobs";
import type { Env } from "./types";

/**
 * Reads the converted XTC body + title header from a successful converter
 * response and writes the final artifact to R2. Shared by the sync /convert
 * path (src/index.ts) and the async Workflow (src/workflow.ts) so the
 * title/metadata handling — and therefore the download filename — stays
 * identical across both. Callers must pass an ok (2xx) converter response.
 */
export async function storeXtcOutput(
  env: Pick<Env, "XTC_BUCKET">,
  jobId: string,
  converterResponse: Response,
): Promise<{ title?: string }> {
  const title = decodeTitleHeader(converterResponse.headers.get("X-Xtc-Title"));
  const xtcBytes = await converterResponse.arrayBuffer();
  await env.XTC_BUCKET.put(outputXtcKey(jobId), xtcBytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    // The download handler reads the title back from here for the
    // Content-Disposition filename.
    customMetadata: title !== undefined ? { title } : undefined,
  });
  return { title };
}
