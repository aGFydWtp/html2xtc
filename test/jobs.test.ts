import { describe, expect, it } from "vitest";
import type { WorkflowStatusLike } from "../src/jobs";
import {
  articleHtmlKey,
  fontsCssKey,
  decideMissingDownload,
  decodeTitleHeader,
  epubFontsCssKey,
  epubHtmlKey,
  inputEpubKey,
  inputTextKey,
  intermediatePdfKey,
  mapInstanceStatus,
  mapTextInstanceStatus,
  needsPhaseProbe,
  outputXtcKey,
  resolveExtractMinChars,
  resolveMaxEpubHtmlBytes,
  resolveMaxPdfBytes,
  sanitizeTitle,
  titleFromOutput,
  xtcContentDisposition,
} from "../src/jobs";

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

const instance = (
  status: WorkflowStatusLike["status"],
  error?: { name: string; message: string },
): WorkflowStatusLike => ({ status, error });

describe("R2 key layout", () => {
  it("puts the intermediate PDF under its own lifecycle prefix", () => {
    expect(intermediatePdfKey(JOB_ID)).toBe(`intermediate/${JOB_ID}/source.pdf`);
  });

  it("keeps the artifact under jobs/", () => {
    expect(outputXtcKey(JOB_ID)).toBe(`jobs/${JOB_ID}/output.xtc`);
  });

  it("shares the intermediate/ lifecycle prefix for the article HTML", () => {
    expect(articleHtmlKey(JOB_ID)).toBe(`intermediate/${JOB_ID}/article.html`);
  });

  it("shares the intermediate/ lifecycle prefix for the fonts css", () => {
    expect(fontsCssKey(JOB_ID)).toBe(`intermediate/${JOB_ID}/fonts.css`);
  });

  it("puts the uploaded TXT under input/ like the uploaded PDF", () => {
    expect(inputTextKey(JOB_ID)).toBe(`input/${JOB_ID}/source.txt`);
  });

  it("puts the uploaded EPUB under input/ like the uploaded PDF/TXT", () => {
    expect(inputEpubKey(JOB_ID)).toBe(`input/${JOB_ID}/source.epub`);
  });

  it("shares the intermediate/ lifecycle prefix for the EPUB HTML", () => {
    expect(epubHtmlKey(JOB_ID)).toBe(`intermediate/${JOB_ID}/epub.html`);
  });

  it("shares the intermediate/ lifecycle prefix for the EPUB fonts css", () => {
    expect(epubFontsCssKey(JOB_ID)).toBe(`intermediate/${JOB_ID}/epub-fonts.css`);
  });
});

describe("resolveMaxEpubHtmlBytes", () => {
  it("defaults to 32 MiB", () => {
    expect(resolveMaxEpubHtmlBytes({})).toBe(33_554_432);
  });

  it("honors a positive override", () => {
    expect(resolveMaxEpubHtmlBytes({ MAX_EPUB_HTML_BYTES: "1000" })).toBe(1000);
  });

  it("falls back on garbage or non-positive values", () => {
    expect(resolveMaxEpubHtmlBytes({ MAX_EPUB_HTML_BYTES: "banana" })).toBe(33_554_432);
    expect(resolveMaxEpubHtmlBytes({ MAX_EPUB_HTML_BYTES: "0" })).toBe(33_554_432);
  });
});

describe("mapTextInstanceStatus", () => {
  it("maps queued", () => {
    expect(mapTextInstanceStatus(JOB_ID, instance("queued"), "preparing")).toEqual({
      jobId: JOB_ID,
      status: "queued",
    });
  });

  it("maps complete to completed with a download URL and title", () => {
    expect(
      mapTextInstanceStatus(
        JOB_ID,
        { status: "complete", output: { xtcKey: "k", title: "小説のタイトル" } },
        "preparing",
      ),
    ).toEqual({
      jobId: JOB_ID,
      status: "completed",
      downloadUrl: `/jobs/${JOB_ID}/download`,
      title: "小説のタイトル",
    });
  });

  it("maps errored/terminated to failed", () => {
    expect(
      mapTextInstanceStatus(
        JOB_ID,
        instance("errored", { name: "Error", message: "text file is empty" }),
        "rendering",
      ),
    ).toEqual({ jobId: JOB_ID, status: "failed", error: "text file is empty" });
    // Workflows runtime embeds the error class name into message; it must be
    // stripped so the frontend's exact-match error mapping keeps working.
    expect(
      mapTextInstanceStatus(
        JOB_ID,
        instance("errored", {
          name: "NonRetryableError",
          message: "NonRetryableError: uploaded file is not a plain text file",
        }),
        "rendering",
      ),
    ).toEqual({
      jobId: JOB_ID,
      status: "failed",
      error: "uploaded file is not a plain text file",
    });
    expect(mapTextInstanceStatus(JOB_ID, instance("terminated"), "rendering")).toEqual({
      jobId: JOB_ID,
      status: "failed",
      error: "unknown error",
    });
  });

  it("passes the phase through for the running family", () => {
    for (const status of ["running", "waiting", "paused", "unknown"] as const) {
      expect(mapTextInstanceStatus(JOB_ID, instance(status), "preparing").status).toBe(
        "preparing",
      );
      expect(mapTextInstanceStatus(JOB_ID, instance(status), "rendering").status).toBe(
        "rendering",
      );
      expect(mapTextInstanceStatus(JOB_ID, instance(status), "converting").status).toBe(
        "converting",
      );
    }
  });
});

describe("resolveExtractMinChars", () => {
  it("defaults to 300", () => {
    expect(resolveExtractMinChars({})).toBe(300);
    expect(resolveExtractMinChars({ EXTRACT_MIN_CHARS: undefined })).toBe(300);
  });

  it("honors a positive override", () => {
    expect(resolveExtractMinChars({ EXTRACT_MIN_CHARS: "500" })).toBe(500);
  });

  it("falls back on garbage or non-positive values", () => {
    expect(resolveExtractMinChars({ EXTRACT_MIN_CHARS: "banana" })).toBe(300);
    expect(resolveExtractMinChars({ EXTRACT_MIN_CHARS: "0" })).toBe(300);
    expect(resolveExtractMinChars({ EXTRACT_MIN_CHARS: "-5" })).toBe(300);
  });
});

describe("needsPhaseProbe", () => {
  it("is false for statuses that map without an R2 probe", () => {
    for (const status of ["queued", "complete", "errored", "terminated"] as const) {
      expect(needsPhaseProbe(status)).toBe(false);
    }
  });

  it("is true for the running family", () => {
    for (const status of [
      "running",
      "waiting",
      "paused",
      "waitingForPause",
      "unknown",
    ] as const) {
      expect(needsPhaseProbe(status)).toBe(true);
    }
  });
});

describe("mapInstanceStatus", () => {
  it("maps queued", () => {
    expect(mapInstanceStatus(JOB_ID, instance("queued"), false)).toEqual({
      jobId: JOB_ID,
      status: "queued",
    });
  });

  it("maps complete to completed with a download URL", () => {
    expect(mapInstanceStatus(JOB_ID, instance("complete"), false)).toEqual({
      jobId: JOB_ID,
      status: "completed",
      downloadUrl: `/jobs/${JOB_ID}/download`,
    });
  });

  it("maps errored to failed with the error message", () => {
    expect(
      mapInstanceStatus(
        JOB_ID,
        instance("errored", { name: "Error", message: "PDF generation failed" }),
        false,
      ),
    ).toEqual({ jobId: JOB_ID, status: "failed", error: "PDF generation failed" });
  });

  it("maps terminated to failed with a fallback message", () => {
    expect(mapInstanceStatus(JOB_ID, instance("terminated"), false)).toEqual({
      jobId: JOB_ID,
      status: "failed",
      error: "unknown error",
    });
  });

  it("derives rendering when the intermediate PDF does not exist yet", () => {
    for (const status of ["running", "waiting", "paused", "unknown"] as const) {
      expect(mapInstanceStatus(JOB_ID, instance(status), false).status).toBe(
        "rendering",
      );
    }
  });

  it("derives converting once the intermediate PDF exists", () => {
    for (const status of ["running", "waiting", "paused", "unknown"] as const) {
      expect(mapInstanceStatus(JOB_ID, instance(status), true).status).toBe(
        "converting",
      );
    }
  });

  it("surfaces the title from the workflow output on completion", () => {
    expect(
      mapInstanceStatus(
        JOB_ID,
        { status: "complete", output: { xtcKey: "k", title: "記事のタイトル" } },
        false,
      ),
    ).toEqual({
      jobId: JOB_ID,
      status: "completed",
      downloadUrl: `/jobs/${JOB_ID}/download`,
      title: "記事のタイトル",
    });
  });

  it("omits title when the workflow output has none", () => {
    expect(
      mapInstanceStatus(JOB_ID, { status: "complete", output: { xtcKey: "k" } }, false),
    ).not.toHaveProperty("title");
  });
});

describe("decideMissingDownload", () => {
  // These cover GET /jobs/:id/download when output.xtc is absent from R2.

  it("returns 404 for completed (artifact expired) and failed jobs", () => {
    expect(
      decideMissingDownload(mapInstanceStatus(JOB_ID, instance("complete"), false)),
    ).toEqual({ kind: "not-found" });
    expect(
      decideMissingDownload(mapInstanceStatus(JOB_ID, instance("errored"), false)),
    ).toEqual({ kind: "not-found" });
  });

  it("returns 409 with the current status for in-flight jobs", () => {
    expect(
      decideMissingDownload(mapInstanceStatus(JOB_ID, instance("queued"), false)),
    ).toEqual({ kind: "conflict", status: "queued" });
    expect(
      decideMissingDownload(mapInstanceStatus(JOB_ID, instance("running"), false)),
    ).toEqual({ kind: "conflict", status: "rendering" });
    expect(
      decideMissingDownload(mapInstanceStatus(JOB_ID, instance("running"), true)),
    ).toEqual({ kind: "conflict", status: "converting" });
  });
});

describe("sanitizeTitle", () => {
  it("passes clean titles through", () => {
    expect(sanitizeTitle("記事のタイトル – サイト名")).toBe("記事のタイトル – サイト名");
  });

  it("strips control characters and path separators, collapses whitespace", () => {
    expect(sanitizeTitle("  a b\tc/d\\e\r\nf  ")).toBe("a b c d e f");
  });

  it("caps the length at 100 characters", () => {
    expect(sanitizeTitle("あ".repeat(300))).toBe("あ".repeat(100));
  });

  it("returns undefined for empty or non-string input", () => {
    expect(sanitizeTitle("")).toBeUndefined();
    expect(sanitizeTitle("   \n ")).toBeUndefined();
    expect(sanitizeTitle(null)).toBeUndefined();
    expect(sanitizeTitle(undefined)).toBeUndefined();
  });
});

describe("decodeTitleHeader", () => {
  it("decodes a UTF-8 percent-encoded header", () => {
    expect(decodeTitleHeader(encodeURIComponent("日本語 タイトル"))).toBe(
      "日本語 タイトル",
    );
  });

  it("returns undefined for a missing header", () => {
    expect(decodeTitleHeader(null)).toBeUndefined();
  });

  it("returns undefined for malformed percent-encoding", () => {
    expect(decodeTitleHeader("%E3%81")).toBeUndefined();
    expect(decodeTitleHeader("%ZZ")).toBeUndefined();
  });
});

describe("titleFromOutput", () => {
  it("extracts a string title", () => {
    expect(titleFromOutput({ xtcKey: "k", title: "T" })).toBe("T");
  });

  it("ignores non-object outputs and non-string titles", () => {
    expect(titleFromOutput(undefined)).toBeUndefined();
    expect(titleFromOutput("nope")).toBeUndefined();
    expect(titleFromOutput({ title: 42 })).toBeUndefined();
    expect(titleFromOutput({})).toBeUndefined();
  });
});

describe("xtcContentDisposition", () => {
  it("falls back to the jobId when there is no title", () => {
    expect(xtcContentDisposition(undefined, JOB_ID)).toBe(
      `attachment; filename="${JOB_ID}.xtc"; filename*=UTF-8''${JOB_ID}.xtc`,
    );
  });

  it("uses an ASCII title for both parameters", () => {
    expect(xtcContentDisposition("My Article", JOB_ID)).toBe(
      `attachment; filename="My Article.xtc"; filename*=UTF-8''My%20Article.xtc`,
    );
  });

  it("percent-encodes a Japanese title and keeps an ASCII fallback", () => {
    const header = xtcContentDisposition("日本語タイトル", JOB_ID);
    expect(header).toBe(
      `attachment; filename="${JOB_ID}.xtc"; filename*=UTF-8''` +
        `${encodeURIComponent("日本語タイトル")}.xtc`,
    );
  });

  it("keeps the ASCII part of a mixed title as the fallback", () => {
    const header = xtcContentDisposition("速報: Workers 101", JOB_ID);
    // ":" is Windows-forbidden and sanitized to a space before encoding.
    expect(header).toContain(`filename="Workers 101.xtc"`);
    expect(header).toContain("filename*=UTF-8''");
  });

  it("never emits quotes or control characters in the plain filename", () => {
    const header = xtcContentDisposition('a"b c', JOB_ID);
    expect(header).toContain(`filename="a b c.xtc"`);
  });

  it("escapes RFC 5987 specials in filename*", () => {
    // "*" is Windows-forbidden and sanitized to a space before encoding.
    const header = xtcContentDisposition("a'b(c)d*e", JOB_ID);
    expect(header).toContain("filename*=UTF-8''a%27b%28c%29d%20e.xtc");
  });

  it("replaces Windows/FAT-forbidden characters with spaces", () => {
    // Real case: an ASCII "|" in a title broke an upload to the X3, while
    // full-width lookalikes (｜) are legal filename characters and are kept.
    const header = xtcContentDisposition("飛び魚｜石田 | web:ゲンロン", JOB_ID);
    expect(header).toContain(
      `filename*=UTF-8''${encodeURIComponent("飛び魚｜石田 web ゲンロン")}.xtc`,
    );
  });
});

describe("resolveMaxPdfBytes", () => {
  it("defaults to 20 MiB", () => {
    expect(resolveMaxPdfBytes({})).toBe(20 * 1024 * 1024);
  });

  it("honors a numeric MAX_PDF_BYTES override", () => {
    expect(resolveMaxPdfBytes({ MAX_PDF_BYTES: "1048576" })).toBe(1048576);
  });

  it("falls back on non-numeric or non-positive values", () => {
    expect(resolveMaxPdfBytes({ MAX_PDF_BYTES: "abc" })).toBe(20 * 1024 * 1024);
    expect(resolveMaxPdfBytes({ MAX_PDF_BYTES: "0" })).toBe(20 * 1024 * 1024);
    expect(resolveMaxPdfBytes({ MAX_PDF_BYTES: "-5" })).toBe(20 * 1024 * 1024);
  });
});
