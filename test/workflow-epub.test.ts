// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EPUB Workflow pipeline tests (EPUB_TO_XTC_IMPLEMENTATION_SPEC.md §14/§19.1).
 * Exercises ConvertWorkflow#run() end-to-end for an `{kind: "epub"}` source,
 * driving it through a fake WorkflowStep (retry/NonRetryableError semantics)
 * and a fake R2 bucket, so this is the first test in the repo to actually
 * invoke src/workflow.ts's run() — every other pipeline in this file
 * (URL/PDF/TXT) has the exact same "cloudflare:workers"/"cloudflare:workflows"
 * import-graph problem and has simply never been covered under plain vitest
 * (see test/index-conversion-mode.test.ts's and test/text-preview.test.ts's
 * doc comments for the same constraint applied to src/index.ts).
 *
 * Mocking boundary, mirroring test/text-preview.test.ts's rationale: real
 * business logic (src/epub/*, src/jobs.ts's key/status helpers,
 * src/epub-upload.ts, src/pipeline.ts's storeXtcOutput) stays real — only
 * the three points that would otherwise need a live Browser
 * Run/Container/Google Fonts network call are mocked:
 * renderSelfStyledHtmlPdf (src/pdf.ts), convertInContainer (src/container.ts),
 * buildInlineFontCss (src/fonts.ts).
 */
vi.mock("cloudflare:workers", () => ({
  // Mirrors the real WorkflowEntrypoint(ctx, env) constructor shape closely
  // enough for `this.env` to be populated the way every step body in
  // src/workflow.ts relies on.
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
  convertInContainer: vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })),
  convertUploadedPdfInContainer: vi.fn(),
}));
vi.mock("../src/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pdf")>();
  return {
    ...actual,
    renderSelfStyledHtmlPdf: vi.fn(
      async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
    ),
  };
});
vi.mock("../src/fonts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fonts")>();
  return { ...actual, buildInlineFontCss: vi.fn(async () => null) };
});

import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { convertInContainer } from "../src/container";
import { DEFAULT_EPUB_OPTIONS } from "../src/epub-options";
import type { EpubConvertOptions } from "../src/epub-options";
import { buildInlineFontCss } from "../src/fonts";
import {
  epubFontsCssKey,
  epubHtmlKey,
  inputEpubKey,
  intermediatePdfKey,
  outputXtcKey,
} from "../src/jobs";
import { renderSelfStyledHtmlPdf } from "../src/pdf";
import { ConvertWorkflow } from "../src/workflow";
import type { ConvertJobParams, ConvertSource, Env } from "../src/types";
import { buildEpubZip, minimalEpub3Files } from "./fixtures/epub/build-epub";

const mockedConvertInContainer = vi.mocked(convertInContainer);
const mockedRenderSelfStyledHtmlPdf = vi.mocked(renderSelfStyledHtmlPdf);
const mockedBuildInlineFontCss = vi.mocked(buildInlineFontCss);

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

// --- FixedLengthStream polyfill ---------------------------------------------
// convert-xtc pipes the intermediate PDF through `new FixedLengthStream(size)`
// (a Workers-runtime-only global, needed so fetch sends a real Content-Length
// to the container's http.server) before handing it to convertInContainer —
// which is mocked below and never actually reads the stream, so a bare
// TransformStream stand-in is enough to keep `.pipeThrough(...)` from
// throwing ReferenceError under plain Node/vitest.
class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(_length: number) {
    super();
  }
}
(globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream = FakeFixedLengthStream;

// --- fake R2 bucket ----------------------------------------------------------

async function toBytes(
  value: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

class FakeR2Bucket {
  objects = new Map<string, Uint8Array>();
  deletedKeys: string[] = [];
  /** Every put(), even for a key later deleted by cleanup — lets tests
   * inspect content (e.g. the generated HTML's <title>) after run()
   * completes and delete-epub-intermediates has already removed it. */
  putLog: { key: string; bytes: Uint8Array }[] = [];
  private getFailuresRemaining = new Map<string, number>();

  /** Makes the next `n` get(key) calls throw a transient (non-EpubError,
   * non-NonRetryableError) error, simulating an R2 hiccup. */
  failGetOnce(key: string, n = 1): void {
    this.getFailuresRemaining.set(key, n);
  }

  async put(
    key: string,
    value: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  ): Promise<void> {
    const bytes = await toBytes(value);
    this.objects.set(key, bytes);
    this.putLog.push({ key, bytes });
  }

  async get(key: string) {
    const remaining = this.getFailuresRemaining.get(key) ?? 0;
    if (remaining > 0) {
      this.getFailuresRemaining.set(key, remaining - 1);
      throw new Error(`simulated R2 outage for ${key}`);
    }
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
      async arrayBuffer(): Promise<ArrayBuffer> {
        return bytes.slice().buffer;
      },
      async text(): Promise<string> {
        return new TextDecoder().decode(bytes);
      },
    };
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

// --- fake WorkflowStep --------------------------------------------------------

/**
 * Approximates the real Workflows engine's step.do() retry contract closely
 * enough to test src/workflow.ts's retry/timeout configuration and its
 * NonRetryableError-vs-plain-Error split: retries the callback up to
 * config.retries.limit additional times unless it throws NonRetryableError
 * (never retried, matching the real runtime), and tracks how many times each
 * named step was attempted.
 */
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

// --- test helpers --------------------------------------------------------------

function fakeEnv(bucket: FakeR2Bucket, extra: Record<string, string> = {}): Env {
  return { XTC_BUCKET: bucket, ...extra } as unknown as Env;
}

function epubSource(bucket: FakeR2Bucket, bytes: Uint8Array, filename = "book.epub"): Extract<ConvertSource, { kind: "epub" }> {
  const key = inputEpubKey(JOB_ID);
  bucket.objects.set(key, bytes);
  return { kind: "epub", key, filename, size: bytes.byteLength };
}

function runEpub(
  env: Env,
  step: FakeWorkflowStep,
  source: Extract<ConvertSource, { kind: "epub" }>,
  epubOptions: EpubConvertOptions = DEFAULT_EPUB_OPTIONS,
): Promise<{ xtcKey: string; title?: string }> {
  const workflow = new ConvertWorkflow({} as never, env);
  const payload: ConvertJobParams = { source, epubOptions };
  const event: WorkflowEvent<ConvertJobParams> = {
    payload,
    timestamp: new Date(),
    instanceId: JOB_ID,
    workflowName: "convert",
  };
  return workflow.run(event, step as unknown as WorkflowStep) as Promise<{
    xtcKey: string;
    title?: string;
  }>;
}

function minimalEpubBytes(): Uint8Array {
  return buildEpubZip(minimalEpub3Files());
}

/** Locates `name`'s ZIP central-directory record (mirrors
 * test/epub/archive.test.ts's identical helper — duplicated rather than
 * imported since that file keeps it module-local). */
function findCentralDirectoryRecordOffset(zip: Uint8Array, name: string): number {
  const nameBytes = new TextEncoder().encode(name);
  for (let i = 0; i < zip.length - 4; i++) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
      const nameLen = new DataView(zip.buffer, zip.byteOffset + i).getUint16(28, true);
      const candidate = zip.subarray(i + 46, i + 46 + nameLen);
      if (
        candidate.length === nameBytes.length &&
        candidate.every((byte, idx) => byte === nameBytes[idx])
      ) {
        return i;
      }
    }
  }
  throw new Error(`central directory record for ${name} not found`);
}

/** Flips bit 0 (encryption) of the general-purpose flag for `name`'s central
 * directory record. */
function markEntryEncrypted(zip: Uint8Array, name: string): Uint8Array {
  const patched = Uint8Array.from(zip);
  const view = new DataView(patched.buffer);
  const offset = findCentralDirectoryRecordOffset(patched, name);
  const flag = view.getUint16(offset + 8, true);
  view.setUint16(offset + 8, flag | 0x1, true);
  return patched;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRenderSelfStyledHtmlPdf.mockResolvedValue(
    new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
  );
  mockedConvertInContainer.mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
  mockedBuildInlineFontCss.mockResolvedValue(null);
});

describe("runEpubSource: happy path (spec §19.1 正常フロー)", () => {
  it("prepares, renders, converts, and returns the XTC key", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();

    const result = await runEpub(fakeEnv(bucket), step, source);

    expect(result.xtcKey).toBe(outputXtcKey(JOB_ID));
    expect(step.callCounts["prepare-epub"]).toBe(1);
    expect(step.callCounts["render-epub-pdf"]).toBe(1);
    expect(step.callCounts["convert-xtc"]).toBe(1);
    expect(step.callCounts["delete-epub-intermediates"]).toBe(1);
    expect(mockedRenderSelfStyledHtmlPdf).toHaveBeenCalledTimes(1);
    expect(mockedConvertInContainer).toHaveBeenCalledTimes(1);
  });
});

describe("runEpubSource: prepare-epub retry (spec §19.1 prepare retry)", () => {
  it("retries once on a transient R2 failure and then succeeds", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    bucket.failGetOnce(source.key, 1);
    const step = new FakeWorkflowStep();

    const result = await runEpub(fakeEnv(bucket), step, source);

    expect(result.xtcKey).toBe(outputXtcKey(JOB_ID));
    expect(step.callCounts["prepare-epub"]).toBe(2);
  });

  it("gives up after the configured retry budget (limit 1 = 2 attempts total)", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    bucket.failGetOnce(source.key, 2);
    const step = new FakeWorkflowStep();

    await expect(runEpub(fakeEnv(bucket), step, source)).rejects.toThrow(
      "simulated R2 outage",
    );
    expect(step.callCounts["prepare-epub"]).toBe(2);
  });
});

describe("runEpubSource: deterministic errors are never retried (spec §19.1)", () => {
  it("a malformed archive throws NonRetryableError after a single attempt", async () => {
    const bucket = new FakeR2Bucket();
    const garbage = new TextEncoder().encode("this is not a zip file at all");
    const source = epubSource(bucket, garbage);
    const step = new FakeWorkflowStep();

    let caught: unknown;
    try {
      await runEpub(fakeEnv(bucket), step, source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NonRetryableError);
    expect((caught as Error).message).toBe("invalid EPUB file");
    expect(step.callCounts["prepare-epub"]).toBe(1);
    // Cleanup still runs on a NonRetryableError failure.
    expect(step.callCounts["delete-epub-intermediates"]).toBe(1);
  });

  it("an encrypted-EPUB rejection is also never retried", async () => {
    const bucket = new FakeR2Bucket();
    // fflate's zipSync has no API to create an encrypted entry — patch the
    // general-purpose flag bit directly, mirroring
    // test/epub/archive.test.ts's markEntryEncrypted helper.
    const zip = buildEpubZip(minimalEpub3Files());
    const patched = markEntryEncrypted(zip, "OEBPS/chapter1.xhtml");
    const source = epubSource(bucket, patched);
    const step = new FakeWorkflowStep();

    let caught: unknown;
    try {
      await runEpub(fakeEnv(bucket), step, source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NonRetryableError);
    expect(step.callCounts["prepare-epub"]).toBe(1);
  });
});

describe("runEpubSource: render-epub-pdf retry (spec §19.1 render retry)", () => {
  it("retries a transient Browser Run failure and then succeeds", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();
    mockedRenderSelfStyledHtmlPdf
      .mockRejectedValueOnce(new Error("transient render failure"))
      .mockResolvedValueOnce(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }));

    const result = await runEpub(fakeEnv(bucket), step, source);

    expect(result.xtcKey).toBe(outputXtcKey(JOB_ID));
    expect(step.callCounts["render-epub-pdf"]).toBe(2);
  });
});

describe("render-epub-pdf error classification (Browser Run error code, not just 422)", () => {
  // The classification helper (src/workflow.ts, shared by all three render
  // steps) is only exercised here — render-epub-pdf is the one step this
  // file's fake WorkflowStep/R2 setup already drives end-to-end.
  it("throws the timeout-specific message when Browser Run's body carries code 6002", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();
    mockedRenderSelfStyledHtmlPdf.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ code: 6002, message: "A timeout was reached: Request timed out" }],
          }),
          { status: 422 },
        ),
    );

    await expect(runEpub(fakeEnv(bucket), step, source)).rejects.toThrow(
      "PDF generation timed out; retrying may succeed",
    );
    // retries stay exactly as configured (limit 2 => 3 attempts) — 6002 is
    // NOT made non-retryable, since the same code has been observed to
    // succeed on a later retry for some inputs.
    expect(step.callCounts["render-epub-pdf"]).toBe(3);
  });

  it("keeps the generic message for a 422 with a different (or no) code", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();
    mockedRenderSelfStyledHtmlPdf.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ errors: [{ code: 9999, message: "out of memory" }] }),
          { status: 422 },
        ),
    );

    await expect(runEpub(fakeEnv(bucket), step, source)).rejects.toThrow(
      "PDF generation failed",
    );
  });

  it("falls back to the generic message when the body is not JSON", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();
    mockedRenderSelfStyledHtmlPdf.mockImplementation(
      async () => new Response("internal server error", { status: 500 }),
    );

    await expect(runEpub(fakeEnv(bucket), step, source)).rejects.toThrow(
      "PDF generation failed",
    );
  });
});

describe("runEpubSource: rendered-PDF size limit (spec §19.1 PDFサイズ超過)", () => {
  it("throws NonRetryableError without retrying when the PDF exceeds MAX_PDF_BYTES", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();
    mockedRenderSelfStyledHtmlPdf.mockResolvedValue(
      new Response(new Uint8Array(64), { status: 200 }),
    );

    let caught: unknown;
    try {
      await runEpub(fakeEnv(bucket, { MAX_PDF_BYTES: "8" }), step, source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NonRetryableError);
    expect((caught as Error).message).toContain("byte limit");
    expect(step.callCounts["render-epub-pdf"]).toBe(1);
  });
});

describe("runEpubSource: convert-xtc retry (spec §19.1 convert retry)", () => {
  it("retries a transient container failure and then succeeds", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();
    mockedConvertInContainer
      .mockRejectedValueOnce(new Error("transient container failure"))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));

    const result = await runEpub(fakeEnv(bucket), step, source);

    expect(result.xtcKey).toBe(outputXtcKey(JOB_ID));
    expect(step.callCounts["convert-xtc"]).toBe(2);
  });
});

describe("runEpubSource: cleanup (spec §19.1 success/failure cleanup)", () => {
  it("deletes every intermediate on success, including the font CSS when one was produced", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();
    mockedBuildInlineFontCss.mockResolvedValue("@font-face { font-family: X; }");

    await runEpub(fakeEnv(bucket), step, source);

    expect(bucket.deletedKeys.sort()).toEqual(
      [
        source.key,
        epubHtmlKey(JOB_ID),
        epubFontsCssKey(JOB_ID),
        intermediatePdfKey(JOB_ID),
      ].sort(),
    );
    // Only the final XTC artifact remains — every intermediate is gone.
    expect([...bucket.objects.keys()]).toEqual([outputXtcKey(JOB_ID)]);
  });

  it("deletes every intermediate even when the job ultimately fails", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes());
    const step = new FakeWorkflowStep();
    // Exhaust convert-xtc's retry budget with a non-413 failure. A fresh
    // Response each call: a Response body can only be read once, and every
    // attempt's error path reads it via response.text() for logging.
    mockedConvertInContainer.mockImplementation(
      async () => new Response("internal error", { status: 500 }),
    );

    await expect(runEpub(fakeEnv(bucket), step, source)).rejects.toThrow(
      "XTC conversion failed",
    );

    expect(step.callCounts["convert-xtc"]).toBe(3); // limit 2 => 3 attempts
    expect(bucket.deletedKeys).toContain(source.key);
    expect(bucket.deletedKeys).toContain(epubHtmlKey(JOB_ID));
    expect(bucket.deletedKeys).toContain(intermediatePdfKey(JOB_ID));
    // No XTC was ever produced.
    expect(bucket.objects.size).toBe(0);
  });
});

describe("runEpubSource: title / author propagation (spec §19.1 title/author伝搬, D1/D12)", () => {
  it("writes the EPUB's OPF title into the generated HTML's <title>, and forwards the OPF author to convertInContainer", async () => {
    const bucket = new FakeR2Bucket();
    const source = epubSource(bucket, minimalEpubBytes()); // dc:title "Minimal Test Book", dc:creator "Test Author"
    const step = new FakeWorkflowStep();
    mockedConvertInContainer.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "X-Xtc-Title": encodeURIComponent("Minimal Test Book") },
      }),
    );

    const result = await runEpub(fakeEnv(bucket), step, source);

    // 1. Phase 3's prepareEpubDocument put the EPUB title into the
    //    self-contained HTML's <title> — the existing HTML-<title> ->
    //    Chromium PDF-metadata -> converter/app.py path (D1) is what
    //    actually carries it into the XTC in production.
    const htmlPut = bucket.putLog.find((entry) => entry.key === epubHtmlKey(JOB_ID));
    expect(htmlPut).toBeDefined();
    const html = new TextDecoder().decode(htmlPut!.bytes);
    expect(html).toContain("<title>Minimal Test Book</title>");

    // 2. The OPF author reaches convertInContainer's request-side `author`
    //    argument (5th positional), exactly like the TXT pipeline.
    expect(mockedConvertInContainer).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      expect.anything(),
      expect.any(Number),
      "Test Author",
    );

    // 3. The mocked container's X-Xtc-Title response header round-trips
    //    through storeXtcOutput into the Workflow's own return value —
    //    the same value GET /jobs/:id surfaces as `title`.
    expect(result.title).toBe("Minimal Test Book");
  });
});
