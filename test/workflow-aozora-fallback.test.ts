// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Aozora Bunko PDF-timeout 4-chunk fallback: end-to-end ConvertWorkflow#run()
 * coverage for a {kind: "url"} source (spec §23 "分岐" / §19 accept criteria),
 * mirroring test/workflow-epub.test.ts's harness (fake WorkflowStep, fake R2
 * bucket) and mocking boundary: prepareRenderInput (src/extract.ts — avoids
 * any real network fetch, spec §27 "外部URLをCIから直接fetchしない"),
 * renderPdfFromHtml/renderPdf (src/pdf.ts) and convertInContainer
 * (src/container.ts) stay mocked; every other piece (src/aozora-fallback/*,
 * src/printhtml.ts, src/jobs.ts's key helpers, src/pipeline.ts's
 * storeXtcOutput) is exercised for real.
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
  convertInContainer: vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })),
  convertUploadedPdfInContainer: vi.fn(),
}));
vi.mock("../src/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pdf")>();
  return {
    ...actual,
    renderPdfFromHtml: vi.fn(),
    renderPdf: vi.fn(),
  };
});
vi.mock("../src/extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/extract")>();
  return { ...actual, prepareRenderInput: vi.fn() };
});

import { PDFDocument } from "pdf-lib";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { convertInContainer } from "../src/container";
import { prepareRenderInput } from "../src/extract";
import type { ExtractedArticle } from "../src/extract";
import { articleHtmlKey, intermediatePdfKey, outputXtcKey } from "../src/jobs";
import { renderPdf, renderPdfFromHtml } from "../src/pdf";
import { buildPrintHtml } from "../src/printhtml";
import { AOZORA_DOCUMENT_CSS } from "../src/aozora";
import { ConvertWorkflow } from "../src/workflow";
import type { ConvertJobParams, Env } from "../src/types";

const mockedConvertInContainer = vi.mocked(convertInContainer);
const mockedRenderPdfFromHtml = vi.mocked(renderPdfFromHtml);
const mockedRenderPdf = vi.mocked(renderPdf);
const mockedPrepareRenderInput = vi.mocked(prepareRenderInput);

const JOB_ID = "1a2b3c4d-5e6f-4708-9abc-def012345678";
const AOZORA_URL = "https://www.aozora.gr.jp/cards/000148/files/789_14547.html";

class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(_length: number) {
    super();
  }
}
(globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream = FakeFixedLengthStream;

// --- fake R2 bucket (mirrors test/workflow-epub.test.ts) --------------------

async function toBytes(
  value: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
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
  /** Keys whose put() is accepted but never actually stored — simulates an
   * R2 object expiring mid-job (extract-content wrote it, but by the time
   * render-pdf reads it back, it's gone). */
  neverPersist = new Set<string>();

  async put(key: string, value: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>): Promise<void> {
    const bytes = await toBytes(value);
    if (!this.neverPersist.has(key)) {
      this.objects.set(key, bytes);
    }
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (bytes === undefined) return null;
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

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
}

// --- fake WorkflowStep (mirrors test/workflow-epub.test.ts) -----------------

class FakeWorkflowStep {
  callCounts: Record<string, number> = {};

  async do<T>(name: string, configOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
    const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<T>;
    const config = (typeof configOrCallback === "function" ? undefined : configOrCallback) as
      | { retries?: { limit: number } }
      | undefined;
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

// --- test helpers -------------------------------------------------------------

function fakeEnv(bucket: FakeR2Bucket, extra: Record<string, string> = {}): Env {
  return { XTC_BUCKET: bucket, ...extra } as unknown as Env;
}

function runUrl(env: Env, step: FakeWorkflowStep, url: string): Promise<{ xtcKey: string; title?: string }> {
  const workflow = new ConvertWorkflow({} as never, env);
  const payload: ConvertJobParams = { source: { kind: "url", url } };
  const event: WorkflowEvent<ConvertJobParams> = {
    payload,
    timestamp: new Date(),
    instanceId: JOB_ID,
    workflowName: "convert",
  };
  return workflow.run(event, step as unknown as WorkflowStep) as Promise<{ xtcKey: string; title?: string }>;
}

/** A large-enough synthetic Aozora-shaped article — same content strategy as
 * test/aozora-fallback/split.test.ts's fixture builder — so the real
 * splitContentIntoChunks/buildAozoraFallbackChunkHtml pipeline this test
 * exercises produces 4 genuinely non-empty, well-formed chunks. */
function aozoraArticleHtml(): string {
  const rubyWord = `<ruby><rb>猫</rb><rp>（</rp><rt>ねこ</rt><rp>）</rp></ruby>`;
  let content = "";
  for (let i = 0; i < 30; i++) {
    if (i > 0 && i % 6 === 0) content += `<h4 class="naka-midashi">第${i / 6}章</h4>`;
    content += `<div class="jisage_1">${"あ".repeat(40)}${rubyWord}${"い".repeat(40)}その${i}。<br /><br /></div>`;
  }
  content += `<div class="bibliographical_information">底本：「サンプル」</div>`;
  const article: ExtractedArticle = {
    title: "吾輩は猫である",
    byline: "夏目漱石",
    siteName: "青空文庫",
    lang: "ja",
    contentHtml: content,
    textContent: "",
  };
  return buildPrintHtml(article, AOZORA_URL, "2026-07-24 12:00 JST", AOZORA_DOCUMENT_CSS);
}

async function onePagePdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 300]);
  return doc.save();
}

function browserRunErrorResponse(code: number): Response {
  return new Response(JSON.stringify({ errors: [{ code, message: "A timeout was reached" }] }), {
    status: 422,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedConvertInContainer.mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
});

// Both 6002 (a genuine Browser Run timeout) and 6003 ("Failed to capture
// screenshot or generate PDF. The page may be too large...") trigger the
// SAME 4-chunk fallback — added per a production observation (see
// AOZORA_FALLBACK_ERROR_CODES's doc comment in src/workflow.ts): the exact
// same document ("神曲・淨火") failed with 6002 during pre-deploy testing
// and with 6003 in a later production run, both citing the same root cause.
describe.each([6002, 6003] as const)(
  "Aozora fallback: eligible job (flag on, aozora-origin, code %i)",
  (errorCode) => {
    it(`splits into 4 chunks, merges, converts once, and never retries the initial ${errorCode}`, async () => {
      const bucket = new FakeR2Bucket();
      const step = new FakeWorkflowStep();
      mockedPrepareRenderInput.mockResolvedValue({
        kind: "html",
        html: aozoraArticleHtml(),
        fontCss: null,
        origin: "aozora",
      });
      const chunkPdf = await onePagePdfBytes();
      mockedRenderPdfFromHtml
        .mockResolvedValueOnce(browserRunErrorResponse(errorCode)) // initial single-document attempt
        // A fresh Response object per call — a Response body can only be
        // read once, and each of the 4 chunk renders reads its own.
        .mockImplementation(async () => new Response(chunkPdf.slice(), { status: 200 }));

      const result = await runUrl(fakeEnv(bucket, { AOZORA_TIMEOUT_FALLBACK_ENABLED: "true" }), step, AOZORA_URL);

      expect(result.xtcKey).toBe(outputXtcKey(JOB_ID));
      // The initial render-pdf step succeeded (returned a discriminated
      // result) on its FIRST attempt — a fallback-eligible code must never
      // spend render-pdf's own retry budget (spec §8/§27).
      expect(step.callCounts["render-pdf"]).toBe(1);
      expect(step.callCounts["prepare-aozora-fallback"]).toBe(1);
      expect(step.callCounts["render-aozora-fallback-0000"]).toBe(1);
      expect(step.callCounts["render-aozora-fallback-0001"]).toBe(1);
      expect(step.callCounts["render-aozora-fallback-0002"]).toBe(1);
      expect(step.callCounts["render-aozora-fallback-0003"]).toBe(1);
      expect(step.callCounts["merge-aozora-fallback-pdf"]).toBe(1);
      expect(step.callCounts["convert-xtc"]).toBe(1);
      // 1 initial attempt + 4 chunk renders — never 4x the same call (spec §27
      // "チャンクを並列処理しない" is implied by this being achievable at all
      // with a synchronous mock queue).
      expect(mockedRenderPdfFromHtml).toHaveBeenCalledTimes(5);
      expect(mockedConvertInContainer).toHaveBeenCalledTimes(1);

      // The merged PDF landed at the SAME key the normal path uses.
      expect(bucket.deletedKeys).toContain(intermediatePdfKey(JOB_ID));
      // Every fallback intermediate was cleaned up (best-effort cleanup ran).
      const fallbackKeysStillPresent = [...bucket.objects.keys()].filter((k) =>
        k.includes("aozora-fallback"),
      );
      expect(fallbackKeysStillPresent).toEqual([]);
      expect(bucket.deletedKeys.some((k) => k.endsWith("aozora-fallback/manifest.json"))).toBe(true);
      expect(bucket.deletedKeys.some((k) => k.endsWith("aozora-fallback/chunks/0003.pdf"))).toBe(true);
    });
  },
);

describe("Aozora timeout fallback: ineligible cases fall through to existing behavior", () => {
  it("does nothing extra when the flag is off — code 6002 still exhausts render-pdf's retry budget and fails", async () => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    mockedPrepareRenderInput.mockResolvedValue({
      kind: "html",
      html: aozoraArticleHtml(),
      fontCss: null,
      origin: "aozora",
    });
    mockedRenderPdfFromHtml.mockImplementation(async () => browserRunErrorResponse(6002));

    await expect(runUrl(fakeEnv(bucket), step, AOZORA_URL)).rejects.toThrow(
      "PDF generation timed out; retrying may succeed",
    );
    expect(step.callCounts["render-pdf"]).toBe(3); // limit 2 => 3 attempts, unchanged
    expect(step.callCounts["prepare-aozora-fallback"]).toBeUndefined();
  });

  it("does not trigger for a degraded (non-aozora-origin) extraction even with the flag on", async () => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    mockedPrepareRenderInput.mockResolvedValue({
      kind: "html",
      html: aozoraArticleHtml(),
      fontCss: null,
      origin: "extract", // dedicated Aozora extraction did NOT succeed
    });
    mockedRenderPdfFromHtml.mockImplementation(async () => browserRunErrorResponse(6002));

    await expect(
      runUrl(fakeEnv(bucket, { AOZORA_TIMEOUT_FALLBACK_ENABLED: "true" }), step, AOZORA_URL),
    ).rejects.toThrow("PDF generation timed out; retrying may succeed");
    expect(step.callCounts["render-pdf"]).toBe(3);
    expect(step.callCounts["prepare-aozora-fallback"]).toBeUndefined();
  });

  // Only AOZORA_FALLBACK_ERROR_CODES (6002, 6003) are eligible — every other
  // code, including a neighboring one (6001) and no code at all (an
  // unparseable/absent body, parseBrowserRunErrorCode -> null), must fall
  // through to the existing throw/retry path untouched. Also guards spec
  // §27 "422だけでfallbackしない": none of these responses trigger the
  // fallback despite all being HTTP 422.
  it.each([
    { label: "a neighboring code (6001)", body: browserRunErrorResponse(6001) },
    { label: "an unrelated code (9999)", body: browserRunErrorResponse(9999) },
    { label: "no machine-readable code at all (unparseable body)", body: new Response("internal error", { status: 422 }) },
  ])("does not trigger on a 422 with $label", async ({ body }) => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    mockedPrepareRenderInput.mockResolvedValue({
      kind: "html",
      html: aozoraArticleHtml(),
      fontCss: null,
      origin: "aozora",
    });
    mockedRenderPdfFromHtml.mockImplementation(async () => body.clone());

    await expect(
      runUrl(fakeEnv(bucket, { AOZORA_TIMEOUT_FALLBACK_ENABLED: "true" }), step, AOZORA_URL),
    ).rejects.toThrow("PDF generation failed");
    expect(step.callCounts["render-pdf"]).toBe(3);
    expect(step.callCounts["prepare-aozora-fallback"]).toBeUndefined();
  });

  it("does not affect a non-Aozora URL at all — full-page render path is untouched", async () => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    mockedRenderPdf.mockResolvedValue(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }));

    const result = await runUrl(
      fakeEnv(bucket, { AOZORA_TIMEOUT_FALLBACK_ENABLED: "true" }),
      step,
      "https://example.com/article",
    );

    expect(result.xtcKey).toBe(outputXtcKey(JOB_ID));
    expect(mockedPrepareRenderInput).not.toHaveBeenCalled();
    expect(step.callCounts["prepare-aozora-fallback"]).toBeUndefined();
  });

  it("does not trigger when the article HTML expired mid-job — this attempt degrades to a full-page render, not extract mode", async () => {
    const bucket = new FakeR2Bucket();
    // extract-content still marks the job as isAozoraOrigin=true (the
    // dedicated extractor DID succeed) and writes articleHtmlKey — but the
    // object is gone by the time render-pdf tries to read it back, so this
    // attempt's own `mode` degrades to "full" (renderPdf, not
    // renderPdfFromHtml) and there is no article HTML to split.
    bucket.neverPersist.add(articleHtmlKey(JOB_ID));
    const step = new FakeWorkflowStep();
    mockedPrepareRenderInput.mockResolvedValue({
      kind: "html",
      html: aozoraArticleHtml(),
      fontCss: null,
      origin: "aozora",
    });
    mockedRenderPdf.mockImplementation(async () => browserRunErrorResponse(6002));

    await expect(
      runUrl(fakeEnv(bucket, { AOZORA_TIMEOUT_FALLBACK_ENABLED: "true" }), step, AOZORA_URL),
    ).rejects.toThrow("PDF generation timed out; retrying may succeed");
    expect(step.callCounts["render-pdf"]).toBe(3); // limit 2 => 3 attempts, unchanged
    expect(step.callCounts["prepare-aozora-fallback"]).toBeUndefined();
    expect(mockedRenderPdfFromHtml).not.toHaveBeenCalled();
  });
});

describe("Aozora timeout fallback: chunk render failure (spec §16.3/§19 'MVPではretry後failed')", () => {
  it("fails the job when a chunk repeatedly hits code 6002, with the fallback-specific message", async () => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    mockedPrepareRenderInput.mockResolvedValue({
      kind: "html",
      html: aozoraArticleHtml(),
      fontCss: null,
      origin: "aozora",
    });
    mockedRenderPdfFromHtml
      .mockResolvedValueOnce(browserRunErrorResponse(6002)) // initial attempt -> fallback
      .mockImplementation(async () => browserRunErrorResponse(6002)); // every chunk attempt fails too

    await expect(
      runUrl(fakeEnv(bucket, { AOZORA_TIMEOUT_FALLBACK_ENABLED: "true" }), step, AOZORA_URL),
    ).rejects.toThrow("PDF generation timed out after fallback splitting");
    expect(step.callCounts["render-aozora-fallback-0000"]).toBe(3); // limit 2 => 3 attempts
    // Cleanup still ran despite the failure.
    const remaining = [...bucket.objects.keys()].filter((k) => k.includes("aozora-fallback"));
    expect(remaining).toEqual([]);
  });
});

describe("Aozora timeout fallback: normal success (no timeout at all)", () => {
  it("never invokes the fallback pipeline when the initial render succeeds", async () => {
    const bucket = new FakeR2Bucket();
    const step = new FakeWorkflowStep();
    mockedPrepareRenderInput.mockResolvedValue({
      kind: "html",
      html: aozoraArticleHtml(),
      fontCss: null,
      origin: "aozora",
    });
    const pdf = await onePagePdfBytes();
    mockedRenderPdfFromHtml.mockResolvedValue(new Response(pdf, { status: 200 })); // called once — a single Response is fine

    const result = await runUrl(
      fakeEnv(bucket, { AOZORA_TIMEOUT_FALLBACK_ENABLED: "true" }),
      step,
      AOZORA_URL,
    );

    expect(result.xtcKey).toBe(outputXtcKey(JOB_ID));
    expect(mockedRenderPdfFromHtml).toHaveBeenCalledTimes(1);
    expect(step.callCounts["prepare-aozora-fallback"]).toBeUndefined();
    expect(step.callCounts["merge-aozora-fallback-pdf"]).toBeUndefined();
  });
});
