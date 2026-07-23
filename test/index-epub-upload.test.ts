// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../src/base64url";

/**
 * Regression coverage for the POST /jobs/epub "failed to store upload" bug:
 * handleCreateEpubJob (src/index.ts) used to hand saveUploadedEpub the raw
 * reconstructed stream from peekLeadingBytes (src/epub-upload.ts) straight
 * through, which has no known length; R2's put() only accepts streams with
 * a known length (Request/Response bodies or the readable half of a
 * FixedLengthStream), so every /jobs/epub upload failed in production with
 * "TypeError: Provided readable stream must have a known length" surfaced
 * as a 500 "failed to store upload". The fix wraps that stream through
 * `new FixedLengthStream(declaredSize)` before it reaches saveUploadedEpub.
 *
 * FixedLengthStream is a Workers-runtime global unavailable under plain
 * vitest (same "cloudflare:workers" runtime constraint documented on
 * src/epub-upload.ts/src/pdf-upload.ts), so this file stubs it with a
 * TransformStream-based fake that mirrors its documented real-world
 * behavior (errors if more bytes are written than declared, and errors if
 * the stream closes having written fewer) well enough to prove: (1)
 * handleCreateEpubJob actually wraps the body through
 * `new FixedLengthStream(declaredSize)` with the correct declared size
 * before calling saveUploadedEpub — the constructor call is spied on — and
 * (2) doing so does not corrupt or truncate the peeked-and-replayed body
 * bytes. It cannot reproduce the real R2 binding's "unknown length"
 * rejection itself — that behavior only exists under the real Workers
 * runtime — so this is necessarily an indirect (wiring + byte-integrity)
 * regression test, not a reproduction of the original stack trace.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
}));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));

const { default: worker } = await import("../src/index");
type Env = import("../src/types").Env;

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

class FakeR2Bucket {
  objects = new Map<string, Uint8Array>();
  deletedKeys: string[] = [];

  async put(key: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const bytes = await drainStream(stream);
    this.objects.set(key, bytes);
  }

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
}

// Behavioral stand-in for the real Workers-global FixedLengthStream: a
// TransformStream that errors if more bytes flow through than declared,
// and errors on flush if fewer bytes flowed through than declared —
// matching FixedLengthStream's documented contract closely enough to
// exercise both the success path and the size-mismatch path below.
function installFakeFixedLengthStream(): number[] {
  const calls: number[] = [];
  class FakeFixedLengthStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(expectedLength: number) {
      calls.push(expectedLength);
      let seen = 0;
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > expectedLength) {
            controller.error(new Error(`wrote more than declared length ${expectedLength}`));
            return;
          }
          controller.enqueue(chunk);
        },
        flush(controller) {
          if (seen !== expectedLength) {
            controller.error(
              new Error(`stream ended with ${seen} bytes, declared length was ${expectedLength}`),
            );
          }
        },
      });
      this.readable = readable;
      this.writable = writable;
    }
  }
  (globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream =
    FakeFixedLengthStream;
  return calls;
}

const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function epubBodyBytes(extra: string): Uint8Array {
  const extraBytes = new TextEncoder().encode(extra);
  const out = new Uint8Array(ZIP_MAGIC.byteLength + extraBytes.byteLength);
  out.set(ZIP_MAGIC, 0);
  out.set(extraBytes, ZIP_MAGIC.byteLength);
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function minimalEnv(bucket: FakeR2Bucket): Env {
  return {
    XTC_BUCKET: bucket,
    CONVERT_WORKFLOW: { create: vi.fn(async () => undefined) },
  } as unknown as Env;
}

describe("POST /jobs/epub full flow — FixedLengthStream wiring (bug: failed to store upload)", () => {
  let fixedLengthStreamCalls: number[];
  const originalFixedLengthStream = (globalThis as unknown as { FixedLengthStream?: unknown })
    .FixedLengthStream;

  beforeEach(() => {
    fixedLengthStreamCalls = installFakeFixedLengthStream();
  });

  afterEach(() => {
    (globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream =
      originalFixedLengthStream;
  });

  it("wraps the body through FixedLengthStream(declaredSize) and stores the exact bytes, still succeeding with 202", async () => {
    const bytes = epubBodyBytes("hello epub body");
    const bucket = new FakeR2Bucket();
    const env = minimalEnv(bucket);

    const request = new Request("https://example.com/jobs/epub", {
      method: "POST",
      headers: {
        "Content-Type": "application/epub+zip",
        "Content-Length": String(bytes.byteLength),
        "X-File-Name": encodeBase64Url("book.epub"),
      },
      body: streamOf(bytes),
      // @ts-expect-error undici requires duplex for a streaming body
      duplex: "half",
    });

    const response = await worker.fetch(request as never, env);
    const responseBody = (await response.json()) as { jobId?: string; error?: string };

    expect(response.status).toBe(202);
    expect(typeof responseBody.jobId).toBe("string");

    // The fix: FixedLengthStream must be constructed with the declared
    // Content-Length before the stream reaches saveUploadedEpub/R2 put().
    expect(fixedLengthStreamCalls).toEqual([bytes.byteLength]);

    // peekLeadingBytes's leading-chunk replay + pipeThrough(FixedLengthStream)
    // must not drop, duplicate, or truncate any bytes.
    expect(bucket.objects.size).toBe(1);
    const stored = [...bucket.objects.values()][0];
    expect(stored).toEqual(bytes);
  });

  it("surfaces an actual size mismatch as 500 failed to store upload (FixedLengthStream errors before the post-put size check runs)", async () => {
    const declaredSize = 100;
    const actualBytes = epubBodyBytes(""); // only 4 bytes, far short of declaredSize
    const bucket = new FakeR2Bucket();
    const env = minimalEnv(bucket);

    const request = new Request("https://example.com/jobs/epub", {
      method: "POST",
      headers: {
        "Content-Type": "application/epub+zip",
        "Content-Length": String(declaredSize),
        "X-File-Name": encodeBase64Url("book.epub"),
      },
      body: streamOf(actualBytes),
      // @ts-expect-error undici requires duplex for a streaming body
      duplex: "half",
    });

    const response = await worker.fetch(request as never, env);
    const responseBody = (await response.json()) as { error?: string };

    expect(response.status).toBe(500);
    expect(responseBody.error).toBe("failed to store upload");
    expect(fixedLengthStreamCalls).toEqual([declaredSize]);
  });
});
