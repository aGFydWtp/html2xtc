// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uploaded-PDF Workflow pipeline tests (ConvertWorkflow#run() for a
 * `{kind: "pdf"}` source). Same harness as test/workflow-epub.test.ts (fake
 * WorkflowStep with the real retry/NonRetryableError split, fake R2 bucket,
 * "cloudflare:*" modules mocked); only the Container call is mocked.
 */
vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("cloudflare:workflows", () => {
  class NonRetryableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NonRetryableError";
    }
  }
  return { NonRetryableError };
});
vi.mock("../src/container", () => ({
  convertInContainer: vi.fn(),
  convertUploadedPdfInContainer: vi.fn(),
}));

import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { convertUploadedPdfInContainer } from "../src/container";
import { inputPdfKey, outputXtcKey } from "../src/jobs";
import { ConvertWorkflow } from "../src/workflow";
import type { ConvertJobParams, ConvertSource, Env } from "../src/types";

const mockedConvertUploadedPdf = vi.mocked(convertUploadedPdfInContainer);

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";
const MAX_BYTES = 100;

// Workers-runtime-only global; the mocked container call never reads the
// stream, so a bare TransformStream stand-in keeps `.pipeThrough(...)` working.
class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(_length: number) {
    super();
  }
}
(globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream = FakeFixedLengthStream;

class FakeR2Bucket {
  objects = new Map<string, Uint8Array>();
  deletedKeys: string[] = [];

  async put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<void> {
    this.objects.set(
      key,
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)),
    );
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (bytes === undefined) {
      return null;
    }
    return {
      size: bytes.byteLength,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
}

class FakeWorkflowStep {
  callCounts: Record<string, number> = {};

  async do<T>(
    name: string,
    configOrCallback: unknown,
    maybeCallback?: () => Promise<T>,
  ): Promise<T> {
    const callback = (
      typeof configOrCallback === "function" ? configOrCallback : maybeCallback
    ) as () => Promise<T>;
    const config = (
      typeof configOrCallback === "function" ? undefined : configOrCallback
    ) as { retries?: { limit: number } } | undefined;
    const limit = config?.retries?.limit ?? 0;

    this.callCounts[name] = 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= limit; attempt++) {
      this.callCounts[name]++;
      try {
        return await callback();
      } catch (error) {
        lastError = error;
        if (error instanceof NonRetryableError) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

function fakeEnv(bucket: FakeR2Bucket): Env {
  return { XTC_BUCKET: bucket, MAX_UPLOAD_PDF_BYTES: String(MAX_BYTES) } as unknown as Env;
}

function pdfSource(
  bucket: FakeR2Bucket,
  byteLength: number,
): Extract<ConvertSource, { kind: "pdf" }> {
  const key = inputPdfKey(JOB_ID);
  bucket.objects.set(key, new Uint8Array(byteLength));
  return { kind: "pdf", key, filename: "doc.pdf", size: byteLength };
}

function runPdf(env: Env, step: FakeWorkflowStep, source: Extract<ConvertSource, { kind: "pdf" }>) {
  const workflow = new ConvertWorkflow({} as never, env);
  const payload: ConvertJobParams = { source };
  const event: WorkflowEvent<ConvertJobParams> = {
    payload,
    timestamp: new Date(),
    instanceId: JOB_ID,
    workflowName: "convert",
  };
  return workflow.run(event, step as unknown as WorkflowStep);
}

beforeEach(() => {
  mockedConvertUploadedPdf.mockReset();
  mockedConvertUploadedPdf.mockImplementation(
    async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
  );
});

describe("runUploadedPdf: pre-send size check", () => {
  it("fails non-retryably without calling the container when the stored PDF is over the limit", async () => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    const source = pdfSource(bucket, MAX_BYTES + 1);

    const error = await runPdf(fakeEnv(bucket), step, source).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetryableError);
    expect((error as Error).message).toBe(`uploaded PDF exceeds the ${MAX_BYTES} byte limit`);
    expect(mockedConvertUploadedPdf).not.toHaveBeenCalled();
    expect(step.callCounts["convert-uploaded-pdf"]).toBe(1);
    // The input is still cleaned up on terminal failure.
    expect(bucket.deletedKeys).toContain(source.key);
  });

  it("sends a PDF of exactly the limit to the container", async () => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    const source = pdfSource(bucket, MAX_BYTES);

    const result = await runPdf(fakeEnv(bucket), step, source);

    expect(mockedConvertUploadedPdf).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ xtcKey: outputXtcKey(JOB_ID) });
  });
});

describe("runUploadedPdf: converter 413 backstop", () => {
  it("keeps the same non-retryable message when the converter itself answers 413", async () => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    const source = pdfSource(bucket, MAX_BYTES);
    mockedConvertUploadedPdf.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "too large", code: "pdf_too_large" }), {
          status: 413,
        }),
    );

    const error = await runPdf(fakeEnv(bucket), step, source).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetryableError);
    expect((error as Error).message).toBe(`uploaded PDF exceeds the ${MAX_BYTES} byte limit`);
    expect(step.callCounts["convert-uploaded-pdf"]).toBe(1);
  });
});
