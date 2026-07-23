// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { EpubFileValidationError, MAX_UPLOAD_EPUB_BYTES, validateEpubFile } from "../src/lib/epub-file-validate";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function epubFile(name: string, bytes: number[] = [...ZIP_MAGIC, 0, 0, 0, 0], type = "application/epub+zip"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("validateEpubFile", () => {
  it("accepts a well-formed EPUB file", async () => {
    await expect(validateEpubFile(epubFile("book.epub"))).resolves.toBeUndefined();
  });

  it("accepts an empty MIME type (some OSes report none for .epub)", async () => {
    await expect(validateEpubFile(epubFile("book.epub", [...ZIP_MAGIC], ""))).resolves.toBeUndefined();
  });

  it("accepts application/octet-stream", async () => {
    await expect(validateEpubFile(epubFile("book.epub", [...ZIP_MAGIC], "application/octet-stream"))).resolves.toBeUndefined();
  });

  it("rejects a non-.epub extension", async () => {
    await expect(validateEpubFile(epubFile("book.zip"))).rejects.toMatchObject({ kind: "not_epub" });
  });

  it("rejects an unsupported MIME type", async () => {
    await expect(validateEpubFile(epubFile("book.epub", [...ZIP_MAGIC], "text/plain"))).rejects.toMatchObject({ kind: "not_epub" });
  });

  it("rejects an empty file", async () => {
    await expect(validateEpubFile(epubFile("book.epub", []))).rejects.toMatchObject({ kind: "empty" });
  });

  it("rejects a file exceeding the size limit", async () => {
    const big = new File([new Uint8Array(10)], "book.epub", { type: "application/epub+zip" });
    await expect(validateEpubFile(big, 5)).rejects.toMatchObject({ kind: "too_large" });
  });

  it("rejects a file missing the ZIP local file header magic bytes", async () => {
    await expect(validateEpubFile(epubFile("book.epub", [0, 1, 2, 3]))).rejects.toMatchObject({ kind: "magic_missing" });
  });

  it("does not misidentify a plain-text file that happens to have a .epub name as valid", async () => {
    const bytes = Array.from(new TextEncoder().encode("just some plain text, not a zip"));
    await expect(validateEpubFile(epubFile("book.epub", bytes))).rejects.toMatchObject({ kind: "magic_missing" });
  });

  it("uses the documented default max size", () => {
    expect(MAX_UPLOAD_EPUB_BYTES).toBe(50331648);
  });

  it("is an instance of EpubFileValidationError", async () => {
    try {
      await validateEpubFile(epubFile("book.zip"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EpubFileValidationError);
    }
  });
});
