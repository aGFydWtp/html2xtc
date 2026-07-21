// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/base64url";
import { inputTextKey } from "../src/jobs";
import { BinaryTextFileError, EncodingDetectionFailedError, Utf16NotSupportedError } from "../src/text-decode";
import {
  EmptyTextError,
  LineTooLongError,
  TextTooLongError,
  TooManyLinesError,
} from "../src/text-normalize";
import {
  decodeTextFilenameHeader,
  isAllowedTextContentType,
  saveUploadedText,
  sanitizeUploadTextFilename,
  textPrepareErrorMessage,
} from "../src/text-upload";

describe("isAllowedTextContentType", () => {
  it("accepts text/plain and application/octet-stream", () => {
    expect(isAllowedTextContentType("text/plain")).toBe(true);
    expect(isAllowedTextContentType("application/octet-stream")).toBe(true);
  });

  it("ignores media-type parameters and is case-insensitive", () => {
    expect(isAllowedTextContentType("Text/Plain; charset=utf-8")).toBe(true);
    expect(isAllowedTextContentType("APPLICATION/OCTET-STREAM")).toBe(true);
  });

  it("rejects everything else, including a missing header", () => {
    expect(isAllowedTextContentType(null)).toBe(false);
    expect(isAllowedTextContentType("application/pdf")).toBe(false);
    expect(isAllowedTextContentType("text/html")).toBe(false);
  });
});

describe("sanitizeUploadTextFilename / decodeTextFilenameHeader (spec §11.4)", () => {
  it("passes a normal filename through unchanged", () => {
    expect(sanitizeUploadTextFilename("novel.txt")).toBe("novel.txt");
  });

  it("appends .txt when there is no extension", () => {
    expect(sanitizeUploadTextFilename("novel")).toBe("novel.txt");
  });

  it("strips control characters", () => {
    const withControlChars = `bad${String.fromCharCode(0)}name${String.fromCharCode(31)}.txt`;
    expect(sanitizeUploadTextFilename(withControlChars)).toBe("badname.txt");
  });

  it("strips path separators — never used as a path or R2 key", () => {
    expect(sanitizeUploadTextFilename("../../etc/passwd.txt")).toBe("....etcpasswd.txt");
    expect(sanitizeUploadTextFilename("C:\\Users\\a\\novel.txt")).toBe("C:Usersanovel.txt");
  });

  it("falls back to document.txt when empty after cleanup", () => {
    expect(sanitizeUploadTextFilename("")).toBe("document.txt");
    expect(sanitizeUploadTextFilename("   ")).toBe("document.txt");
    expect(sanitizeUploadTextFilename("///")).toBe("document.txt");
  });

  it("caps length at 255 code points", () => {
    const long = "a".repeat(300) + ".txt";
    const result = sanitizeUploadTextFilename(long);
    expect(Array.from(result).length).toBeLessThanOrEqual(255 + 4);
  });

  it("NFC-normalizes the filename", () => {
    // decomposed が (base + combining dakuten) must normalize
    // to precomposed が.
    const decomposed = "がnovel.txt";
    expect(sanitizeUploadTextFilename(decomposed)).toBe("がnovel.txt");
  });

  it("decodeTextFilenameHeader defaults to document.txt when the header is absent", () => {
    expect(decodeTextFilenameHeader(null)).toBe("document.txt");
  });

  it("decodeTextFilenameHeader decodes a base64url UTF-8 filename", () => {
    const encoded = encodeBase64Url("小説.txt");
    expect(decodeTextFilenameHeader(encoded)).toBe("小説.txt");
  });

  it("decodeTextFilenameHeader degrades to the default rather than failing on bad base64url", () => {
    expect(decodeTextFilenameHeader("not valid base64!")).toBe("document.txt");
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

function streamOf(bytes: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("saveUploadedText", () => {
  const KEY = inputTextKey("0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f");

  it("stores the body and reports ok when the stored size matches", async () => {
    const bucket = new FakeR2Bucket();
    const bytes = new TextEncoder().encode("こんにちは");
    const result = await saveUploadedText(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(bytes),
      bytes.byteLength,
      "novel.txt",
    );
    expect(result).toEqual({ ok: true });
    expect(bucket.objects.has(KEY)).toBe(true);
  });

  it("deletes the object and returns 500 when R2 put() throws", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putShouldThrow = true;
    const result = await saveUploadedText(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(new Uint8Array([1])),
      1,
      "novel.txt",
    );
    expect(result).toEqual({ ok: false, status: 500, error: "failed to store upload" });
  });

  it("deletes the object and returns 400 when the stored size does not match Content-Length", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putStoresWrongSize = 3;
    const result = await saveUploadedText(
      { XTC_BUCKET: bucket as unknown as R2Bucket },
      KEY,
      streamOf(new Uint8Array([1, 2, 3, 4, 5])),
      5,
      "novel.txt",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
    expect(bucket.objects.has(KEY)).toBe(false);
    expect(bucket.deletedKeys).toContain(KEY);
  });
});

describe("textPrepareErrorMessage (spec §19.1 condition mapping)", () => {
  it("maps each text-decode/text-normalize error to a distinct stable message", () => {
    const messages = new Set<string>();
    const cases: [unknown, string][] = [
      [new Utf16NotSupportedError(), "UTF-16 is not supported; convert the file to UTF-8"],
      [new BinaryTextFileError(), "uploaded file is not a plain text file"],
      [new EncodingDetectionFailedError(), "unable to determine the text encoding"],
      [new EmptyTextError(), "text file is empty"],
      [new TextTooLongError(), "text is too long to convert"],
      [new TooManyLinesError(), "line count exceeds the limit"],
      [new LineTooLongError(), "a line exceeds the maximum line length"],
    ];
    for (const [error, expected] of cases) {
      const message = textPrepareErrorMessage(error);
      expect(message).toBe(expected);
      messages.add(message);
    }
    expect(messages.size).toBe(cases.length); // every condition is distinguishable
  });

  it("falls back to a generic message for an unrecognized error", () => {
    expect(textPrepareErrorMessage(new Error("something else"))).toBe(
      "failed to convert text to XTC",
    );
    expect(textPrepareErrorMessage("not even an Error")).toBe("failed to convert text to XTC");
  });
});
