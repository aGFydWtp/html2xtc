// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/base64url";
import { checkContentLength } from "../src/pdf-upload";
import { inputEpubKey } from "../src/jobs";
import {
  decodeEpubFilenameHeader,
  hasEpubZipMagic,
  isAllowedEpubContentType,
  peekLeadingBytes,
  resolveMaxUploadEpubBytes,
  saveUploadedEpub,
  sanitizeUploadEpubFilename,
} from "../src/epub-upload";

describe("isAllowedEpubContentType (spec §7.1)", () => {
  it("always accepts application/epub+zip", () => {
    expect(isAllowedEpubContentType("application/epub+zip", "book.txt")).toBe(true);
  });

  it("ignores media-type parameters and is case-insensitive", () => {
    expect(isAllowedEpubContentType("Application/Epub+Zip; charset=binary", "book.epub")).toBe(
      true,
    );
  });

  it("accepts application/octet-stream only with a .epub filename", () => {
    expect(isAllowedEpubContentType("application/octet-stream", "book.epub")).toBe(true);
    expect(isAllowedEpubContentType("application/octet-stream", "book.EPUB")).toBe(true);
    expect(isAllowedEpubContentType("application/octet-stream", "book.zip")).toBe(false);
    expect(isAllowedEpubContentType("application/octet-stream", "document.epub")).toBe(true);
  });

  it("rejects everything else, including a missing header", () => {
    expect(isAllowedEpubContentType(null, "book.epub")).toBe(false);
    expect(isAllowedEpubContentType("application/zip", "book.epub")).toBe(false);
    expect(isAllowedEpubContentType("text/plain", "book.epub")).toBe(false);
  });
});

describe("resolveMaxUploadEpubBytes", () => {
  it("defaults to 48 MiB", () => {
    expect(resolveMaxUploadEpubBytes({})).toBe(50_331_648);
  });

  it("honors a positive override", () => {
    expect(resolveMaxUploadEpubBytes({ MAX_UPLOAD_EPUB_BYTES: "1000000" })).toBe(1_000_000);
  });

  it("falls back on garbage or non-positive values", () => {
    expect(resolveMaxUploadEpubBytes({ MAX_UPLOAD_EPUB_BYTES: "banana" })).toBe(50_331_648);
    expect(resolveMaxUploadEpubBytes({ MAX_UPLOAD_EPUB_BYTES: "0" })).toBe(50_331_648);
    expect(resolveMaxUploadEpubBytes({ MAX_UPLOAD_EPUB_BYTES: "-1" })).toBe(50_331_648);
  });
});

describe("checkContentLength (reused from src/pdf-upload.ts, spec §7.3)", () => {
  it("still works for the EPUB upload's own byte cap", () => {
    expect(checkContentLength(null, 1000)).toEqual({ kind: "missing" });
    expect(checkContentLength("1001", 1000)).toEqual({ kind: "too-large", length: 1001 });
    expect(checkContentLength("500", 1000)).toEqual({ kind: "ok", length: 500 });
  });
});

describe("sanitizeUploadEpubFilename / decodeEpubFilenameHeader", () => {
  it("passes a normal filename through unchanged", () => {
    expect(sanitizeUploadEpubFilename("book.epub")).toBe("book.epub");
  });

  it("appends .epub when there is no extension", () => {
    expect(sanitizeUploadEpubFilename("book")).toBe("book.epub");
  });

  it("strips control characters and path separators", () => {
    expect(sanitizeUploadEpubFilename("../../etc/passwd.epub")).toBe("....etcpasswd.epub");
  });

  it("falls back to document.epub when empty after cleanup", () => {
    expect(sanitizeUploadEpubFilename("")).toBe("document.epub");
    expect(sanitizeUploadEpubFilename("///")).toBe("document.epub");
  });

  it("decodeEpubFilenameHeader defaults to document.epub when the header is absent or undecodable", () => {
    expect(decodeEpubFilenameHeader(null)).toBe("document.epub");
    expect(decodeEpubFilenameHeader("not valid base64!")).toBe("document.epub");
  });

  it("decodeEpubFilenameHeader decodes a base64url UTF-8 filename", () => {
    const encoded = encodeBase64Url("小説.epub");
    expect(decodeEpubFilenameHeader(encoded)).toBe("小説.epub");
  });
});

describe("hasEpubZipMagic (spec §7.2)", () => {
  it("accepts the three documented ZIP magic byte sequences", () => {
    expect(hasEpubZipMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(hasEpubZipMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(hasEpubZipMagic(new Uint8Array([0x50, 0x4b, 0x07, 0x08]))).toBe(true);
  });

  it("rejects non-ZIP bytes", () => {
    expect(hasEpubZipMagic(new TextEncoder().encode("%PDF-1.4"))).toBe(false);
  });

  it("rejects fewer than 4 bytes", () => {
    expect(hasEpubZipMagic(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(hasEpubZipMagic(new Uint8Array([]))).toBe(false);
  });
});

function streamOf(bytes: Uint8Array, chunkSize = bytes.byteLength || 1): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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

describe("peekLeadingBytes", () => {
  it("reports the leading bytes and replays the full stream byte-for-byte", async () => {
    const original = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
    const { leading, body } = await peekLeadingBytes(streamOf(original, 3), 4);
    expect(Array.from(leading)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const replayed = await readAll(body);
    expect(Array.from(replayed)).toEqual(Array.from(original));
  });

  it("handles a stream shorter than minBytes without hanging", async () => {
    const original = new Uint8Array([1, 2]);
    const { leading, body } = await peekLeadingBytes(streamOf(original, 1), 4);
    expect(Array.from(leading)).toEqual([1, 2]);
    expect(Array.from(await readAll(body))).toEqual([1, 2]);
  });
});

class FakeR2Bucket {
  objects = new Map<string, { size: number }>();
  deletedKeys: string[] = [];
  putShouldThrow = false;
  putStoresWrongSize: number | null = null;

  async put(key: string, value: ReadableStream): Promise<void> {
    if (this.putShouldThrow) {
      throw new Error("simulated R2 outage");
    }
    const reader = value.getReader();
    let size = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
    }
    this.objects.set(key, { size: this.putStoresWrongSize ?? size });
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { size: object.size } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
}

describe("saveUploadedEpub (spec §7.3, mirrors saveUploadedPdf/saveUploadedText)", () => {
  const KEY = inputEpubKey("0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f");

  it("stores the body and reports ok when the stored size matches", async () => {
    const bucket = new FakeR2Bucket();
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const result = await saveUploadedEpub(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(bytes),
      bytes.byteLength,
      "book.epub",
    );
    expect(result).toEqual({ ok: true });
    expect(bucket.objects.has(KEY)).toBe(true);
  });

  it("deletes the object and returns 500 when R2 put() throws", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putShouldThrow = true;
    const result = await saveUploadedEpub(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(new Uint8Array([1])),
      1,
      "book.epub",
    );
    expect(result).toEqual({ ok: false, status: 500, error: "failed to store upload" });
  });

  it("deletes the object and returns 400 when the stored size does not match Content-Length", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putStoresWrongSize = 3;
    const result = await saveUploadedEpub(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(new Uint8Array([1, 2, 3, 4])),
      4,
      "book.epub",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
    expect(bucket.deletedKeys).toContain(KEY);
  });
});
