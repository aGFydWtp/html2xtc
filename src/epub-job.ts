// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { deleteBestEffort, saveUploadedEpub } from "./epub-upload";
import type { EpubConvertOptions } from "./epub-options";
import { inputEpubKey } from "./jobs";
import type { ConvertJobParams, Env } from "./types";

/**
 * Common "store an EPUB in R2, then create the existing ConvertWorkflow"
 * step, shared by POST /jobs/epub (src/index.ts#handleCreateEpubJob) and the
 * OPDS import endpoint (src/integrations/opds/service.ts's startOpdsImport,
 * OPDS spec §17 "既存POST /jobs/epubから、R2保存とWorkflow作成を共通化する").
 *
 * Deliberately narrow: everything HTTP-specific (header parsing, Content-
 * Type/Content-Length gates, rate limiting, the ZIP-magic leading-bytes
 * peek) stays with each caller — this function only does the part that is
 * byte-for-byte identical between an uploaded EPUB and one streamed in from
 * an external OPDS acquisition link: generate the R2 key, stream `body` into
 * R2 (never buffering the whole EPUB, spec §17/§18's "response.arrayBuffer()
 * で EPUB 全体をメモリへ載せない"), verify the stored size against
 * `declaredSize`, build ConvertJobParams, and create the Workflow instance —
 * deleting the R2 object on any failure so a partial/orphaned object never
 * lingers past a failed create() call. This is the *same* ConvertWorkflow
 * every other source kind uses (never duplicated, spec §28).
 */

export interface CreateStoredEpubJobInput {
  body: ReadableStream<Uint8Array>;
  declaredSize: number;
  filename: string;
  epubOptions: EpubConvertOptions;
  /**
   * Provenance metadata, matching the OPDS spec §17 interface shape
   * verbatim. Accepted for shape-fidelity with the spec but NOT currently
   * persisted anywhere — ConvertJobParams has no slot for provenance today,
   * and nothing downstream (job status, library) reads it. A caller that
   * needs an audit trail for *why* a job was created logs it itself (see
   * src/integrations/opds/service.ts's `integration.opds.import_started`),
   * using the accountId/connectionId/provider it already has in scope
   * rather than round-tripping them through this function.
   */
  sourceMetadata: {
    sourceType: "epub-upload" | "opds";
    provider?: string;
    connectionId?: string;
  };
}

export type CreateStoredEpubJobResult =
  | { ok: true; jobId: string; statusUrl: string }
  | { ok: false; status: number; error: string };

export async function createStoredEpubJob(
  env: Env,
  input: CreateStoredEpubJobInput,
): Promise<CreateStoredEpubJobResult> {
  const jobId = crypto.randomUUID();
  const key = inputEpubKey(jobId);

  const saveResult = await saveUploadedEpub(
    env,
    key,
    // Unlike a Request body (whose length the platform already knows), a
    // caller-provided ReadableStream (e.g. an upstream fetch() Response's
    // body, or a reconstructed peekLeadingBytes stream) may have no known
    // length, and R2 put() only accepts streams with one — same
    // FixedLengthStream requirement documented on convertInContainer
    // (src/container.ts) and used identically by the pre-refactor
    // handleCreateEpubJob this function replaces.
    input.body.pipeThrough(new FixedLengthStream(input.declaredSize)),
    input.declaredSize,
    input.filename,
  );
  if (!saveResult.ok) {
    return { ok: false, status: saveResult.status, error: saveResult.error };
  }

  const params: ConvertJobParams = {
    source: { kind: "epub", key, filename: input.filename, size: input.declaredSize },
    epubOptions: input.epubOptions,
  };

  try {
    await env.CONVERT_WORKFLOW.create({
      id: jobId,
      params,
      retention: {
        successRetention: "1 day",
        errorRetention: "1 day",
      },
    });
  } catch (error) {
    console.error(`[${jobId}] workflow create failed`, error);
    await deleteBestEffort(env, key);
    return { ok: false, status: 500, error: "failed to create job" };
  }

  return { ok: true, jobId, statusUrl: `/jobs/${jobId}` };
}
