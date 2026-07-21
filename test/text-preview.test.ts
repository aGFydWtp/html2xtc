import { afterEach, describe, expect, it, vi } from "vitest";

// src/container.ts and src/ratelimiter.ts both import from "cloudflare:workers"
// at module top level (Container/DurableObject base classes), which only
// resolves under the real workerd runtime — this project's vitest.config.ts
// runs plain Node (see src/ratelimit.ts's own doc comment: the DO class is
// deliberately kept out of the pure, vitest-testable helpers for the same
// reason). Since src/preview/text-preview.ts imports convertInContainer and
// enforcePurposeRateLimit from those two modules for production wiring, this
// is the one test file in the repo that needs vi.mock — not to fake business
// logic, but to keep an external native-binding dependency out of the import
// graph entirely so the rest of the (real) handler logic can run under plain
// vitest. convertInContainer's/enforcePurposeRateLimit's own internals stay
// uncovered here, matching the pre-existing lack of any test for
// src/container.ts or for handleConvert (src/index.ts), which has the exact
// same dependency and the exact same gap today.
vi.mock("../src/container", () => ({
  convertInContainer: vi.fn(async () => new Response(new ArrayBuffer(0), { status: 200 })),
}));
vi.mock("../src/ratelimiter", () => ({
  enforcePurposeRateLimit: vi.fn(async () => null),
}));

import { convertInContainer } from "../src/container";
import {
  MAX_TEXT_PREVIEW_CODE_POINTS,
  MAX_TEXT_PREVIEW_REQUEST_BYTES,
  MAX_TEXT_PREVIEW_UTF8_BYTES,
  SyncConversionError,
  convertHtmlToXtcSync,
  handleTextPreview,
  isJsonContentType,
  jsonError,
  parseOptionalContentLength,
  readLimitedJson,
  validateTextPreviewRequest,
} from "../src/preview/text-preview";
import { enforcePurposeRateLimit } from "../src/ratelimiter";
import { DEFAULT_TEXT_OPTIONS } from "../src/text-options";
import type { Env } from "../src/types";

const mockedConvertInContainer = vi.mocked(convertInContainer);
const mockedEnforcePurposeRateLimit = vi.mocked(enforcePurposeRateLimit);

// --- test helpers ------------------------------------------------------------

/** Minimal valid XTC container header (frontend/src/lib/xtc.ts's parseXtc /
 * convertHtmlToXtcSync's readXtcPageCount both only look at the first 8
 * bytes: magic (Uint32LE), version (Uint16LE), pageCount (Uint16LE)). */
function fakeXtcBytes(pageCount: number): ArrayBuffer {
  const buf = new ArrayBuffer(48);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x00435458, true);
  dv.setUint16(4, 0x0100, true);
  dv.setUint16(6, pageCount, true);
  return buf;
}

interface FakeEnvOptions {
  quickAction?: (action: string, options: unknown) => Promise<Response>;
  maxPdfBytes?: string;
}

/** Builds a fake Env exposing only the BROWSER binding src/pdf.ts's
 * renderSelfStyledHtmlPdf actually calls (test/pdf.test.ts's own casting
 * style: {quickAction} as unknown as BrowserRun). Deliberately omits
 * XTC_BUCKET: any code path that touched R2 would throw on the missing
 * binding, which is itself the "preview never persists to R2" assertion.
 * XTC_CONVERTER/RATE_LIMITER are omitted too — convertInContainer and
 * enforcePurposeRateLimit are mocked wholesale above, so neither binding is
 * ever dereferenced. */
function fakeEnv(opts: FakeEnvOptions = {}): Env {
  const quickAction = vi.fn(
    opts.quickAction ?? (async () => new Response("%PDF", { status: 200 })),
  );
  return {
    BROWSER: { quickAction } as unknown as Env["BROWSER"],
    ...(opts.maxPdfBytes !== undefined ? { MAX_PDF_BYTES: opts.maxPdfBytes } : {}),
  } as unknown as Env;
}

function validOptions(overrides: Partial<typeof DEFAULT_TEXT_OPTIONS> = {}) {
  return {
    ...DEFAULT_TEXT_OPTIONS,
    margins: { ...DEFAULT_TEXT_OPTIONS.margins },
    ...overrides,
  };
}

function previewRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/preview/text", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  mockedConvertInContainer.mockReset();
  mockedConvertInContainer.mockImplementation(async () => new Response(fakeXtcBytes(1), { status: 200 }));
  mockedEnforcePurposeRateLimit.mockReset();
  mockedEnforcePurposeRateLimit.mockImplementation(async () => null);
});

// --- isJsonContentType --------------------------------------------------------

describe("isJsonContentType", () => {
  it("accepts application/json, ignoring parameters", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("APPLICATION/JSON")).toBe(true);
  });

  it("rejects null, other types, and text/plain", () => {
    expect(isJsonContentType(null)).toBe(false);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("multipart/form-data")).toBe(false);
  });
});

// --- parseOptionalContentLength ----------------------------------------------

describe("parseOptionalContentLength", () => {
  it("returns null when the header is absent", () => {
    expect(parseOptionalContentLength(null)).toBeNull();
  });

  it("returns null for non-numeric, zero, or negative values (treated as unspecified)", () => {
    for (const value of ["abc", "0", "-5", "1.5", ""]) {
      expect(parseOptionalContentLength(value)).toBeNull();
    }
  });

  it("parses a valid positive integer", () => {
    expect(parseOptionalContentLength("12345")).toBe(12345);
  });
});

// --- readLimitedJson -----------------------------------------------------------

describe("readLimitedJson", () => {
  function streamBody(bytes: Uint8Array): Request {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return new Request("https://example.com/x", {
      method: "POST",
      body: stream,
      // @ts-expect-error Node's fetch requires duplex for streamed bodies.
      duplex: "half",
    });
  }

  it("parses a small JSON body", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    const result = await readLimitedJson<{ a: number }>(streamBody(bytes), 1024);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("reports too-large once the streamed body exceeds maxBytes", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ a: "x".repeat(2000) }));
    const result = await readLimitedJson<{ a: string }>(streamBody(bytes), 1024);
    expect(result).toEqual({ ok: false, kind: "too-large" });
  });

  it("reports invalid-json for a body that doesn't parse", async () => {
    const bytes = new TextEncoder().encode("not json");
    const result = await readLimitedJson(streamBody(bytes), 1024);
    expect(result).toEqual({ ok: false, kind: "invalid-json" });
  });

  it("reports invalid-json when the request has no body", async () => {
    const result = await readLimitedJson(new Request("https://example.com/x"), 1024);
    expect(result).toEqual({ ok: false, kind: "invalid-json" });
  });
});

// --- validateTextPreviewRequest ------------------------------------------------

describe("validateTextPreviewRequest", () => {
  it("accepts a valid body and forces showPageNumbers to false", () => {
    const result = validateTextPreviewRequest({
      text: "本文",
      options: validOptions({ showPageNumbers: true }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.showPageNumbers).toBe(false);
    }
  });

  it("rejects a non-object body", () => {
    const result = validateTextPreviewRequest("nope");
    expect(result).toMatchObject({ ok: false, status: 400, code: "INVALID_REQUEST" });
  });

  it("rejects a missing or non-string text field", () => {
    expect(validateTextPreviewRequest({ options: validOptions() })).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_REQUEST",
    });
    expect(validateTextPreviewRequest({ text: 123, options: validOptions() })).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_REQUEST",
    });
  });

  it("accepts exactly MAX_TEXT_PREVIEW_CODE_POINTS code points", () => {
    const text = "a".repeat(MAX_TEXT_PREVIEW_CODE_POINTS);
    const result = validateTextPreviewRequest({ text, options: validOptions() });
    expect(result.ok).toBe(true);
  });

  it("rejects one code point over the limit with 413 TEXT_TOO_LONG", () => {
    const text = "a".repeat(MAX_TEXT_PREVIEW_CODE_POINTS + 1);
    const result = validateTextPreviewRequest({ text, options: validOptions() });
    expect(result).toMatchObject({ ok: false, status: 413, code: "TEXT_TOO_LONG" });
  });

  it("counts surrogate pairs as one code point, not two", () => {
    // Each emoji is one code point (U+1F600 etc.) but two UTF-16 code units;
    // 4,000 of them must be accepted on the code-point check (though this
    // particular text is rejected below on the UTF-8 byte limit instead,
    // since emoji are 4 bytes each in UTF-8 — the two limits are independent).
    const text = "\u{1F600}".repeat(MAX_TEXT_PREVIEW_CODE_POINTS);
    expect(text.length).toBe(MAX_TEXT_PREVIEW_CODE_POINTS * 2); // UTF-16 units
    const result = validateTextPreviewRequest({ text, options: validOptions() });
    // 4,000 code points passes the code-point check but 16,000 UTF-8 bytes
    // is still under the 32 KiB byte limit, so this should be accepted.
    expect(result.ok).toBe(true);
  });

  it("accepts MAX_TEXT_PREVIEW_CODE_POINTS worth of 3-byte multi-byte text (well under the byte cap)", () => {
    const text = "あ".repeat(MAX_TEXT_PREVIEW_CODE_POINTS);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_TEXT_PREVIEW_UTF8_BYTES);
    const result = validateTextPreviewRequest({ text, options: validOptions() });
    expect(result.ok).toBe(true);
  });

  it("documents that the UTF-8 byte limit is currently unreachable given the code-point cap", () => {
    // UTF-8 encodes at most 4 bytes per code point (astral characters), so
    // MAX_TEXT_PREVIEW_CODE_POINTS (4,000) code points can never exceed
    // 16,000 bytes — well under the 32 KiB byte cap. That means, as
    // currently configured, the code-point check alone always rejects an
    // over-limit text before the byte check could ever fire; the byte check
    // is pure defense-in-depth (spec §5.3/§9). This test pins that fact so a
    // future bump to MAX_TEXT_PREVIEW_CODE_POINTS that makes the byte limit
    // newly reachable gets noticed rather than silently changing behavior.
    const maxPossibleUtf8Bytes = MAX_TEXT_PREVIEW_CODE_POINTS * 4;
    expect(maxPossibleUtf8Bytes).toBeLessThan(MAX_TEXT_PREVIEW_UTF8_BYTES);
  });

  it("rejects invalid options with 400 INVALID_OPTIONS", () => {
    const result = validateTextPreviewRequest({
      text: "本文",
      options: { ...validOptions(), fontSizePx: 999 },
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: "INVALID_OPTIONS" });
  });
});

// --- convertHtmlToXtcSync ------------------------------------------------------

describe("convertHtmlToXtcSync", () => {
  it("returns the XTC bytes and page count on success, forwarding jobId/timeoutMs", async () => {
    mockedConvertInContainer.mockImplementation(async () => new Response(fakeXtcBytes(3), { status: 200 }));
    const env = fakeEnv();
    const result = await convertHtmlToXtcSync(env, {
      jobId: "job-1",
      html: "<html></html>",
      fontCss: null,
      timeoutMs: 90_000,
    });
    expect(result.pageCount).toBe(3);
    expect(new Uint8Array(result.xtcBytes).byteLength).toBe(48);
    expect(mockedConvertInContainer).toHaveBeenCalledWith(env, "job-1", expect.anything(), 90_000);
  });

  it("returns pageCount null for a response too short/malformed to be an XTC header", async () => {
    mockedConvertInContainer.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const result = await convertHtmlToXtcSync(fakeEnv(), {
      jobId: "job-1",
      html: "<html></html>",
      fontCss: null,
      timeoutMs: 90_000,
    });
    expect(result.pageCount).toBeNull();
  });

  it("maps a Browser Run exception to 502 PDF_GENERATION_FAILED", async () => {
    const env = fakeEnv({
      quickAction: async () => {
        throw new Error("boom");
      },
    });
    await expect(
      convertHtmlToXtcSync(env, { jobId: "j", html: "<html></html>", fontCss: null, timeoutMs: 90_000 }),
    ).rejects.toMatchObject({ status: 502, code: "PDF_GENERATION_FAILED" });
  });

  it("maps a non-ok Browser Run response to 502 PDF_GENERATION_FAILED", async () => {
    const env = fakeEnv({ quickAction: async () => new Response("nope", { status: 500 }) });
    await expect(
      convertHtmlToXtcSync(env, { jobId: "j", html: "<html></html>", fontCss: null, timeoutMs: 90_000 }),
    ).rejects.toMatchObject({ status: 502, code: "PDF_GENERATION_FAILED" });
  });

  it("maps an oversized rendered PDF to 422 PDF_TOO_LARGE", async () => {
    const env = fakeEnv({ maxPdfBytes: "2" }); // "%PDF" is 4 bytes, over this cap
    await expect(
      convertHtmlToXtcSync(env, { jobId: "j", html: "<html></html>", fontCss: null, timeoutMs: 90_000 }),
    ).rejects.toMatchObject({ status: 422, code: "PDF_TOO_LARGE" });
    // The oversized-PDF check must run before ever calling the container.
    expect(mockedConvertInContainer).not.toHaveBeenCalled();
  });

  it("maps a container fetch timeout to 504 TIMEOUT", async () => {
    mockedConvertInContainer.mockImplementation(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(
      convertHtmlToXtcSync(fakeEnv(), { jobId: "j", html: "<html></html>", fontCss: null, timeoutMs: 90_000 }),
    ).rejects.toMatchObject({ status: 504, code: "TIMEOUT" });
  });

  it("maps a generic container fetch failure to 502 CONTAINER_UNAVAILABLE", async () => {
    mockedConvertInContainer.mockImplementation(async () => {
      throw new Error("network down");
    });
    await expect(
      convertHtmlToXtcSync(fakeEnv(), { jobId: "j", html: "<html></html>", fontCss: null, timeoutMs: 90_000 }),
    ).rejects.toMatchObject({ status: 502, code: "CONTAINER_UNAVAILABLE" });
  });

  it("maps a container 413 to 422 PDF_TOO_LARGE", async () => {
    mockedConvertInContainer.mockImplementation(async () => new Response("too big", { status: 413 }));
    await expect(
      convertHtmlToXtcSync(fakeEnv(), { jobId: "j", html: "<html></html>", fontCss: null, timeoutMs: 90_000 }),
    ).rejects.toMatchObject({ status: 422, code: "PDF_TOO_LARGE" });
  });

  it("maps any other non-ok container response to 502 XTC_CONVERSION_FAILED", async () => {
    mockedConvertInContainer.mockImplementation(async () => new Response("bad", { status: 500 }));
    const env = fakeEnv();
    await expect(
      convertHtmlToXtcSync(env, { jobId: "j", html: "<html></html>", fontCss: null, timeoutMs: 90_000 }),
    ).rejects.toBeInstanceOf(SyncConversionError);
    await expect(
      convertHtmlToXtcSync(env, { jobId: "j", html: "<html></html>", fontCss: null, timeoutMs: 90_000 }),
    ).rejects.toMatchObject({ status: 502, code: "XTC_CONVERSION_FAILED" });
  });
});

// --- jsonError -----------------------------------------------------------------

describe("jsonError", () => {
  it("builds the flat {error, code} body with the given status", async () => {
    const response = jsonError(413, "TEXT_TOO_LONG", "too long");
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too long", code: "TEXT_TOO_LONG" });
  });
});

// --- handleTextPreview (integration) -------------------------------------------

describe("handleTextPreview", () => {
  function stubFontFetchSuccess(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("fonts.googleapis.com")) {
          return new Response(
            "@font-face{font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/s/test/v1/a.woff2) format('woff2');}",
            { status: 200 },
          );
        }
        if (url.includes("fonts.gstatic.com")) {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  }

  function stubFontFetchFailure(): void {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
  }

  it("rejects a non-JSON Content-Type with 415", async () => {
    const request = previewRequest(
      { text: "本文", options: validOptions() },
      { "Content-Type": "text/plain" },
    );
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(415);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects an oversized declared Content-Length with 413, before reading the body", async () => {
    const request = previewRequest(
      { text: "本文", options: validOptions() },
      { "Content-Length": String(MAX_TEXT_PREVIEW_REQUEST_BYTES + 1) },
    );
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(413);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "TEXT_TOO_LONG" });
  });

  it("rejects invalid JSON with 400", async () => {
    const request = new Request("https://example.com/preview/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(400);
  });

  it("rejects a missing text field with 400", async () => {
    const request = previewRequest({ options: validOptions() });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(400);
  });

  it("rejects invalid options with 400", async () => {
    const request = previewRequest({ text: "本文", options: { ...validOptions(), fontSizePx: 1 } });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(400);
  });

  it("rejects text over the code point limit with 413", async () => {
    const request = previewRequest({
      text: "a".repeat(MAX_TEXT_PREVIEW_CODE_POINTS + 1),
      options: validOptions(),
    });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(413);
  });

  it("rejects text normalizing to empty (whitespace only) with 422", async () => {
    const request = previewRequest({ text: "   \n\n   ", options: validOptions() });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(422);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "EMPTY_TEXT" });
    // Never reaches font/render/convert for empty input.
    expect(mockedConvertInContainer).not.toHaveBeenCalled();
  });

  it("returns 429 with the flat error shape and Retry-After when rate limited", async () => {
    mockedEnforcePurposeRateLimit.mockImplementation(async () =>
      Response.json(
        { error: { code: "RATE_LIMITED", message: "rate limit exceeded; try again later" } },
        { status: 429, headers: { "Retry-After": "42" } },
      ),
    );
    const request = previewRequest({ text: "本文", options: validOptions() });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toEqual({
      error: "rate limit exceeded; try again later",
      code: "RATE_LIMITED",
    });
    // The rate limit gate must run before the body is even parsed.
    expect(mockedConvertInContainer).not.toHaveBeenCalled();
  });

  it("passes the preview-text purpose and failClosed:false to enforcePurposeRateLimit", async () => {
    stubFontFetchFailure();
    const request = previewRequest({ text: "本文", options: validOptions() });
    await handleTextPreview(request, fakeEnv());
    expect(mockedEnforcePurposeRateLimit).toHaveBeenCalledWith(
      request,
      expect.anything(),
      expect.objectContaining({ purpose: "preview-text", failClosed: false }),
    );
  });

  it("returns 200 with the XTC bytes and headers on success, and never touches R2", async () => {
    stubFontFetchSuccess();
    mockedConvertInContainer.mockImplementation(async () => new Response(fakeXtcBytes(2), { status: 200 }));
    const request = previewRequest({
      text: "本文のプレビューです。",
      options: validOptions({ title: "サンプル" }),
    });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="preview.xtc"');
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Xtc-Page-Count")).toBe("2");
    expect(response.headers.get("X-Preview-Character-Count")).toBe(
      String(Array.from("本文のプレビューです。").length),
    );
    expect(response.headers.get("X-Preview-Font-Fallback")).toBeNull();
    const bytes = await response.arrayBuffer();
    expect(bytes.byteLength).toBe(48);
  });

  it("sets X-Preview-Font-Fallback and still returns 200 when the font fetch fails", async () => {
    stubFontFetchFailure();
    const request = previewRequest({ text: "本文", options: validOptions() });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Preview-Font-Fallback")).toBe("true");
  });

  it("forces showPageNumbers off in the options passed to HTML generation, even when requested on", async () => {
    stubFontFetchFailure();
    let capturedHtml = "";
    const env = fakeEnv({
      quickAction: async (_action, options) => {
        capturedHtml = (options as { html: string }).html;
        return new Response("%PDF", { status: 200 });
      },
    });
    const request = previewRequest({
      text: "本文",
      options: validOptions({ showPageNumbers: true }),
    });
    const response = await handleTextPreview(request, env);
    expect(response.status).toBe(200);
    expect(capturedHtml).toContain("本文");
  });

  it("maps a Container failure to 502 with the flat error shape", async () => {
    stubFontFetchFailure();
    mockedConvertInContainer.mockImplementation(async () => new Response("fail", { status: 500 }));
    const request = previewRequest({ text: "本文", options: validOptions() });
    const response = await handleTextPreview(request, fakeEnv());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "XTC conversion failed",
      code: "XTC_CONVERSION_FAILED",
    });
  });
});
