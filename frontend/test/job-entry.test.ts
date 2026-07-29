// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { migrateJobEntry } from "../src/lib/job-entry";

describe("migrateJobEntry", () => {
  it("migrates a legacy URL-only entry (no sourceType/sourceLabel)", () => {
    const legacy = {
      jobId: "job-1",
      url: "https://example.com/article",
      status: "completed",
      createdAt: "2026-07-01T00:00:00.000Z",
      title: "Example",
    };
    expect(migrateJobEntry(legacy)).toEqual({
      jobId: "job-1",
      sourceType: "url",
      sourceLabel: "https://example.com/article",
      url: "https://example.com/article",
      status: "completed",
      createdAt: "2026-07-01T00:00:00.000Z",
      title: "Example",
      error: undefined,
      device: undefined,
    });
  });

  it("passes through a current-format URL entry unchanged", () => {
    const current = {
      jobId: "job-2",
      sourceType: "url",
      sourceLabel: "https://example.com/x",
      url: "https://example.com/x",
      status: "queued",
    };
    expect(migrateJobEntry(current)).toEqual({
      jobId: "job-2",
      sourceType: "url",
      sourceLabel: "https://example.com/x",
      url: "https://example.com/x",
      status: "queued",
      createdAt: undefined,
      title: undefined,
      error: undefined,
      device: undefined,
    });
  });

  it("passes through a current-format PDF entry (no url field)", () => {
    const pdfEntry = {
      jobId: "job-3",
      sourceType: "pdf",
      sourceLabel: "document.pdf",
      status: "converting",
    };
    expect(migrateJobEntry(pdfEntry)).toEqual({
      jobId: "job-3",
      sourceType: "pdf",
      sourceLabel: "document.pdf",
      url: undefined,
      status: "converting",
      createdAt: undefined,
      title: undefined,
      error: undefined,
      device: undefined,
    });
  });

  it("carries device through for a completed entry that has it", () => {
    const completed = {
      jobId: "job-device-1",
      sourceType: "pdf",
      sourceLabel: "document.pdf",
      status: "completed",
      device: "x4",
    };
    expect(migrateJobEntry(completed)).toEqual({
      jobId: "job-device-1",
      sourceType: "pdf",
      sourceLabel: "document.pdf",
      url: undefined,
      status: "completed",
      createdAt: undefined,
      title: undefined,
      error: undefined,
      device: "x4",
    });
  });

  it("leaves device undefined for a legacy URL entry (never had the field)", () => {
    const legacy = { jobId: "job-device-2", url: "https://example.com", status: "completed" };
    expect(migrateJobEntry(legacy)?.device).toBeUndefined();
  });

  it("ignores a non-string device value", () => {
    const malformed = { jobId: "job-device-3", sourceType: "pdf", sourceLabel: "a.pdf", status: "completed", device: 123 };
    expect(migrateJobEntry(malformed)?.device).toBeUndefined();
  });

  it("passes through a current-format TXT entry (no url field)", () => {
    const txtEntry = {
      jobId: "job-txt-1",
      sourceType: "txt",
      sourceLabel: "novel.txt",
      status: "preparing",
    };
    expect(migrateJobEntry(txtEntry)).toEqual({
      jobId: "job-txt-1",
      sourceType: "txt",
      sourceLabel: "novel.txt",
      url: undefined,
      status: "preparing",
      createdAt: undefined,
      title: undefined,
      error: undefined,
      device: undefined,
    });
  });

  it("drops a txt-shaped entry missing sourceLabel", () => {
    expect(migrateJobEntry({ jobId: "job-txt-2", sourceType: "txt", status: "failed" })).toBeNull();
  });

  it("passes through a current-format EPUB entry (no url field)", () => {
    const epubEntry = {
      jobId: "job-epub-1",
      sourceType: "epub",
      sourceLabel: "book.epub",
      status: "preparing",
    };
    expect(migrateJobEntry(epubEntry)).toEqual({
      jobId: "job-epub-1",
      sourceType: "epub",
      sourceLabel: "book.epub",
      url: undefined,
      status: "preparing",
      createdAt: undefined,
      title: undefined,
      error: undefined,
      device: undefined,
    });
  });

  it("drops an epub-shaped entry missing sourceLabel", () => {
    expect(migrateJobEntry({ jobId: "job-epub-2", sourceType: "epub", status: "failed" })).toBeNull();
  });

  it("drops entries missing both url and sourceType/sourceLabel", () => {
    expect(migrateJobEntry({ jobId: "job-4", status: "failed" })).toBeNull();
  });

  it("drops a pdf-shaped entry missing sourceLabel", () => {
    expect(migrateJobEntry({ jobId: "job-5", sourceType: "pdf", status: "failed" })).toBeNull();
  });

  it("drops non-object input", () => {
    expect(migrateJobEntry(null)).toBeNull();
    expect(migrateJobEntry("job-6")).toBeNull();
    expect(migrateJobEntry(42)).toBeNull();
  });

  it("drops entries missing jobId or status", () => {
    expect(migrateJobEntry({ url: "https://example.com", status: "queued" })).toBeNull();
    expect(migrateJobEntry({ jobId: "job-7", url: "https://example.com" })).toBeNull();
  });
});
