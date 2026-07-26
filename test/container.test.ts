// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it, vi } from "vitest";

// src/container.ts imports @cloudflare/containers's Container/getContainer,
// and Container itself extends DurableObject/WorkerEntrypoint from
// "cloudflare:workers" — both only resolve under the real workerd runtime.
// Same stub shape as test/index-conversion-mode.test.ts (the one other file
// that imports src/container.ts transitively). @cloudflare/containers itself
// is left REAL (importOriginal) so XtcConverterContainer's `extends
// Container` still gets the genuine base class — only getContainer is
// swapped for a stub whose returned object's `fetch` this file inspects.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

const fetchMock = vi.fn(async (_request: Request) => new Response(null, { status: 200 }));
vi.mock("@cloudflare/containers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/containers")>();
  return { ...actual, getContainer: vi.fn(() => ({ fetch: fetchMock })) };
});

const { convertInContainer } = await import("../src/container");
const { decodeBase64Url } = await import("../src/base64url");
type Env = import("../src/types").Env;
type XtcChapter = import("../packages/aozora-text/src/index").XtcChapter;

function minimalEnv(): Env {
  return { XTC_CONVERTER: {} } as unknown as Env;
}

/** Pulls the single Request convertInContainer/convertUploadedPdfInContainer
 * handed to the (stubbed) container's fetch(), for header inspection. */
function capturedRequest(): Request {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("fetch was never called");
  }
  return call[0] as Request;
}

describe("convertInContainer — X-Xtc-Author", () => {
  it("omits the header entirely when author is undefined", async () => {
    await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000);
    expect(capturedRequest().headers.has("X-Xtc-Author")).toBe(false);
  });

  it("omits the header entirely when author is an empty string", async () => {
    await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, "");
    expect(capturedRequest().headers.has("X-Xtc-Author")).toBe(false);
  });

  it("base64url-encodes a UTF-8 author", async () => {
    await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, "夏目漱石");
    const header = capturedRequest().headers.get("X-Xtc-Author");
    expect(header).not.toBeNull();
    // base64url alphabet only (RFC 4648 §5): no '+', '/', or '=' padding.
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBase64Url(header as string)).toBe("夏目漱石");
  });
});

describe("convertInContainer — X-Xtc-Chapters", () => {
  const chapters: XtcChapter[] = [
    { name: "第一章", marker: "XTCCH0001" },
    { name: "第二章", marker: "XTCCH0002" },
  ];

  it("omits the header entirely when chapters is undefined", async () => {
    await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, "著者");
    expect(capturedRequest().headers.has("X-Xtc-Chapters")).toBe(false);
  });

  it("omits the header entirely when chapters is an empty array (not merely 'falsy')", async () => {
    await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, []);
    expect(capturedRequest().headers.has("X-Xtc-Chapters")).toBe(false);
  });

  it("base64url-encodes the chapter list as JSON, decodable back to the exact input", async () => {
    await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, chapters);
    const header = capturedRequest().headers.get("X-Xtc-Chapters");
    expect(header).not.toBeNull();
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeBase64Url(header as string);
    expect(decoded).not.toBeNull();
    expect(JSON.parse(decoded as string)).toEqual(chapters);
  });

  it("sends both X-Xtc-Author and X-Xtc-Chapters together (TXT/Aozora pipelines can have both)", async () => {
    await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, "著者名", chapters);
    const req = capturedRequest();
    expect(decodeBase64Url(req.headers.get("X-Xtc-Author") as string)).toBe("著者名");
    expect(JSON.parse(decodeBase64Url(req.headers.get("X-Xtc-Chapters") as string) as string)).toEqual(
      chapters,
    );
  });
});

function makeChapters(count: number): XtcChapter[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `章${i + 1}`,
    marker: `XTCCH${String(i + 1).padStart(4, "0")}`,
  }));
}

describe("convertInContainer — A-2: MAX_XTC_CHAPTERS (200) cap", () => {
  it("sends the chapter list unchanged when it is exactly at the 200 cap", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const chapters = makeChapters(200);
      await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, chapters);
      const header = capturedRequest().headers.get("X-Xtc-Chapters");
      const decoded = JSON.parse(decodeBase64Url(header as string) as string);
      expect(decoded).toHaveLength(200);
      expect(decoded).toEqual(chapters);
      // No truncation at exactly the cap — nothing logged.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("truncates to the first 200 chapters when the list exceeds the cap, and logs the drop (never silent)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const chapters = makeChapters(584); // measured real-world 中見出し count
      await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, chapters);
      const header = capturedRequest().headers.get("X-Xtc-Chapters");
      const decoded = JSON.parse(decodeBase64Url(header as string) as string);
      expect(decoded).toHaveLength(200);
      // Truncation keeps the FIRST 200 (document/chapter order), not an
      // arbitrary subset.
      expect(decoded).toEqual(chapters.slice(0, 200));
      // The drop is logged, with both the original count and how many were
      // dropped (384 = 584 - 200) — never a silent truncation.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls[0]?.join(" ") ?? "";
      expect(logged).toContain("job-1");
      expect(logged).toContain("584");
      expect(logged).toContain("200");
      expect(logged).toContain("384");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not log or truncate when chapters is undefined or already under the cap", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000);
      await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, makeChapters(3));
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("convertInContainer — chapter-detection diagnostic headers (log-only)", () => {
  const chapters: XtcChapter[] = [
    { name: "第一章", marker: "XTCCH0001" },
    { name: "第二章", marker: "XTCCH0002" },
  ];

  it("logs nothing when no chapters were requested (sent=0), regardless of response headers", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "X-Xtc-Chapters-Status": "not-requested" },
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("logs at console.log with status=ok when all diagnostic headers are present and valid", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          "X-Xtc-Chapters-Requested": "2",
          "X-Xtc-Chapters-Detected": "2",
          "X-Xtc-Chapters-Status": "ok",
          "X-Xtc-Page-Count": "42",
        },
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, chapters);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = logSpy.mock.calls[0]?.join(" ") ?? "";
      expect(line).toBe(
        "[job-1] chapters: sent=2 requested=2 detected=2 status=ok pageCount=42",
      );
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("logs at console.warn (not console.log) when status is not ok", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          "X-Xtc-Chapters-Requested": "2",
          "X-Xtc-Chapters-Detected": "0",
          "X-Xtc-Chapters-Status": "no-markers-found",
          "X-Xtc-Page-Count": "42",
        },
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, chapters);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = warnSpy.mock.calls[0]?.join(" ") ?? "";
      expect(line).toBe(
        "[job-1] chapters: sent=2 requested=2 detected=0 status=no-markers-found pageCount=42",
      );
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("degrades to 'missing'/'unknown' (never crashes, never logs a raw garbled value) when headers are entirely absent — e.g. an older Container image", async () => {
    // fetchMock's module-level default (no explicit mockResolvedValueOnce)
    // returns a bare 200 Response with none of these headers set.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, chapters),
      ).resolves.toBeInstanceOf(Response);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = warnSpy.mock.calls[0]?.join(" ") ?? "";
      expect(line).toBe(
        "[job-1] chapters: sent=2 requested=unknown detected=unknown status=missing pageCount=missing",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("treats an unrecognized status and malformed counts as 'unknown', never passing the raw header text into the log line", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          "X-Xtc-Chapters-Requested": "12abc; DROP TABLE",
          "X-Xtc-Chapters-Detected": "-1",
          "X-Xtc-Chapters-Status": "some-future-status-not-yet-in-the-whitelist",
          "X-Xtc-Page-Count": "",
        },
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await convertInContainer(minimalEnv(), "job-1", new ArrayBuffer(0), 30_000, undefined, chapters);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = warnSpy.mock.calls[0]?.join(" ") ?? "";
      expect(line).toBe(
        "[job-1] chapters: sent=2 requested=unknown detected=unknown status=unknown pageCount=failed",
      );
      expect(line).not.toContain("DROP TABLE");
      expect(line).not.toContain("some-future-status-not-yet-in-the-whitelist");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// convertUploadedPdfInContainer is deliberately not covered here: it has no
// `chapters` parameter at all (uploaded PDFs have no Worker-derived chapter
// list to send — see its own doc comment in src/container.ts), so there is
// nothing this feature adds to it worth asserting.
