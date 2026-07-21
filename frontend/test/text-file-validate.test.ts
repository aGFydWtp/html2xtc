// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_TEXT_BYTES,
  TextFileValidationError,
  validateTextFile,
} from "../src/lib/text-file-validate";

function makeFile(bytes: number[] | Uint8Array, name = "novel.txt", type = "text/plain"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const OK_UTF8 = Array.from(new TextEncoder().encode("こんにちは、世界。"));

describe("validateTextFile", () => {
  it("accepts a well-formed .txt file", async () => {
    await expect(validateTextFile(makeFile(OK_UTF8))).resolves.toBeUndefined();
  });

  it("accepts an empty MIME type (many OS/browser combos report '')", async () => {
    await expect(validateTextFile(makeFile(OK_UTF8, "novel.txt", ""))).resolves.toBeUndefined();
  });

  it("rejects a non-.txt extension", async () => {
    await expect(validateTextFile(makeFile(OK_UTF8, "novel.md"))).rejects.toMatchObject({ kind: "not_text" });
  });

  it("rejects an unsupported MIME type", async () => {
    await expect(validateTextFile(makeFile(OK_UTF8, "novel.txt", "application/json"))).rejects.toMatchObject({
      kind: "not_text",
    });
  });

  it("rejects an empty file", async () => {
    await expect(validateTextFile(makeFile([]))).rejects.toMatchObject({ kind: "empty" });
  });

  it("rejects a file larger than the byte limit", async () => {
    const big = new File([new Uint8Array(MAX_UPLOAD_TEXT_BYTES + 1)], "big.txt", { type: "text/plain" });
    await expect(validateTextFile(big)).rejects.toMatchObject({ kind: "too_large" });
  });

  it("accepts a file exactly at the byte limit", async () => {
    const exact = new File([new Uint8Array(MAX_UPLOAD_TEXT_BYTES).fill(0x41)], "exact.txt", { type: "text/plain" });
    await expect(validateTextFile(exact)).resolves.toBeUndefined();
  });

  it("rejects a UTF-16LE BOM", async () => {
    await expect(validateTextFile(makeFile([0xff, 0xfe, 0x41, 0x00]))).rejects.toMatchObject({ kind: "utf16" });
  });

  it("rejects a UTF-16BE BOM", async () => {
    await expect(validateTextFile(makeFile([0xfe, 0xff, 0x00, 0x41]))).rejects.toMatchObject({ kind: "utf16" });
  });

  it("rejects content with a NUL byte", async () => {
    await expect(validateTextFile(makeFile([0x41, 0x00, 0x42]))).rejects.toMatchObject({ kind: "binary" });
  });

  it("rejects a PDF magic", async () => {
    await expect(validateTextFile(makeFile([0x25, 0x50, 0x44, 0x46, 0x2d]))).rejects.toMatchObject({ kind: "binary" });
  });

  it("rejects a ZIP magic", async () => {
    await expect(validateTextFile(makeFile([0x50, 0x4b, 0x03, 0x04]))).rejects.toMatchObject({ kind: "binary" });
  });

  it("rejects a PNG magic", async () => {
    await expect(validateTextFile(makeFile([0x89, 0x50, 0x4e, 0x47]))).rejects.toMatchObject({ kind: "binary" });
  });

  it("rejects a garbage byte sequence with a high control-byte ratio but no known magic or NUL byte", async () => {
    // No NUL byte, no recognized magic header — only the ASCII-control-byte
    // ratio (>5%) flags this as binary. Mirrors src/text-decode.ts's
    // looksBinary heuristic that this file now ports.
    const bytes = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 0x01 : 0x41));
    await expect(validateTextFile(makeFile(bytes))).rejects.toMatchObject({ kind: "binary" });
  });

  it("detects a high control-byte ratio beyond the old 64-byte sniff window", async () => {
    // The first 64 bytes look like plain text (0% control bytes); the
    // control-byte density only shows up later in the file. With the old
    // 64-byte SNIFF_BYTES window this file would have passed as text; with
    // the 64 KiB window (matching the server) it's correctly rejected.
    const head = new Array(64).fill(0x41); // plain "AAAA...." — looks like text
    const tail = new Array(500).fill(0x01); // dense C0 control bytes
    await expect(validateTextFile(makeFile(head.concat(tail)))).rejects.toMatchObject({ kind: "binary" });
  });

  it("TextFileValidationError carries the error kind and message", async () => {
    try {
      await validateTextFile(makeFile([]));
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TextFileValidationError);
      expect((e as TextFileValidationError).kind).toBe("empty");
    }
  });
});
