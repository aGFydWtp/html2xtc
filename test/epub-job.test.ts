// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoredEpubJob } from "../src/epub-job";

/**
 * FixedLengthStream is a Cloudflare Workers-runtime global, unavailable
 * under plain vitest (see test/index-epub-upload.test.ts's identical
 * stand-in, which this mirrors) — createStoredEpubJob constructs one
 * internally, so every test below needs it installed first.
 */
function installFakeFixedLengthStream(): void {
  class FakeFixedLengthStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(expectedLength: number) {
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
            controller.error(new Error(`stream ended with ${seen} bytes, declared length was ${expectedLength}`));
          }
        },
      });
      this.readable = readable;
      this.writable = writable;
    }
  }
  (globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream = FakeFixedLengthStream;
}

const EPUB_OPTIONS = {
  layout: "auto" as const,
  font: "BIZ UDMincho",
  fontSizePx: 24,
  marginPx: 40,
  chapterPageBreak: true,
  includeCover: true,
  includeTableOfContents: false,
  device: "x3" as const,
};

function bodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function buildEnv(overrides: Record<string, unknown> = {}) {
  const stored = new Map<string, { size: number }>();
  return {
    XTC_BUCKET: {
      put: vi.fn(async (key: string, _body: unknown, options: { customMetadata?: Record<string, string> }) => {
        void options;
        stored.set(key, { size: 4 });
      }),
      head: vi.fn(async (key: string) => stored.get(key) ?? null),
      delete: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
    },
    CONVERT_WORKFLOW: { create: vi.fn(async () => undefined) },
    ...overrides,
  };
}

describe("createStoredEpubJob", () => {
  const originalFixedLengthStream = (globalThis as unknown as { FixedLengthStream?: unknown }).FixedLengthStream;

  beforeEach(() => {
    installFakeFixedLengthStream();
  });

  afterEach(() => {
    (globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream = originalFixedLengthStream;
  });

  it("stores the EPUB in R2, creates the Workflow, and returns jobId/statusUrl", async () => {
    const env = buildEnv();
    const result = await createStoredEpubJob(env as never, {
      body: bodyStream(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
      declaredSize: 4,
      filename: "book.epub",
      epubOptions: EPUB_OPTIONS,
      sourceMetadata: { sourceType: "epub-upload" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statusUrl).toBe(`/jobs/${result.jobId}`);
    }
    expect(env.CONVERT_WORKFLOW.create).toHaveBeenCalledTimes(1);
    const params = (env.CONVERT_WORKFLOW.create as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
    expect(params.source.kind).toBe("epub");
    expect(params.epubOptions).toEqual(EPUB_OPTIONS);
  });

  it("deletes the R2 object and reports failure when Workflow create() throws", async () => {
    const env = buildEnv({ CONVERT_WORKFLOW: { create: vi.fn(async () => { throw new Error("boom"); }) } });
    const result = await createStoredEpubJob(env as never, {
      body: bodyStream(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
      declaredSize: 4,
      filename: "book.epub",
      epubOptions: EPUB_OPTIONS,
      sourceMetadata: { sourceType: "opds", provider: "memlane", connectionId: "conn-1" },
    });
    expect(result.ok).toBe(false);
    expect(env.XTC_BUCKET.delete).toHaveBeenCalledTimes(1);
  });

  it("reports failure without creating a Workflow when the stored size doesn't match declaredSize", async () => {
    const env = buildEnv();
    const result = await createStoredEpubJob(env as never, {
      body: bodyStream(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
      declaredSize: 999, // FixedLengthStream would actually enforce this in the real runtime; here it exercises saveUploadedEpub's own R2-head size check
      filename: "book.epub",
      epubOptions: EPUB_OPTIONS,
      sourceMetadata: { sourceType: "epub-upload" },
    });
    expect(result.ok).toBe(false);
    expect(env.CONVERT_WORKFLOW.create).not.toHaveBeenCalled();
  });
});
