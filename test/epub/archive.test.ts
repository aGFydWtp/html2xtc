// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  extractEpubArchive,
  resolveEpubRelativePath,
  resolveMaxEpubEntries,
  resolveMaxEpubEntryBytes,
  resolveMaxEpubUncompressedBytes,
  validateEpubMimetype,
} from "../../src/epub/archive";
import { EpubError } from "../../src/epub/errors";
import { buildEpubZip } from "../fixtures/epub/build-epub";

const GENEROUS_LIMITS = {
  maxEntries: 5000,
  maxEntryBytes: 33_554_432,
  maxTotalUncompressedBytes: 201_326_592,
};

/** Finds a ZIP central directory record by exact file name and returns its byte offset (into the record, not the filename). */
function findCentralDirectoryRecordOffset(zip: Uint8Array, name: string): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let offset = 0; offset + 4 <= zip.length; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      continue;
    }
    const filenameLen = view.getUint16(offset + 28, true);
    const nameBytes = zip.subarray(offset + 46, offset + 46 + filenameLen);
    if (new TextDecoder().decode(nameBytes) === name) {
      return offset;
    }
  }
  throw new Error(`central directory record for ${name} not found`);
}

/** Flips bit 0 (encryption) of the general-purpose flag for `name`'s central directory record — fflate's zipSync has no API to create an encrypted entry, so this patches the raw bytes directly. */
function markEntryEncrypted(zip: Uint8Array, name: string): Uint8Array {
  const patched = Uint8Array.from(zip);
  const view = new DataView(patched.buffer);
  const offset = findCentralDirectoryRecordOffset(patched, name);
  const flag = view.getUint16(offset + 8, true);
  view.setUint16(offset + 8, flag | 0x1, true);
  return patched;
}

describe("extractEpubArchive: happy path (spec §19.1 正常ZIP)", () => {
  it("extracts every non-directory entry and skips directory entries", () => {
    const zip = buildEpubZip({
      mimetype: "application/epub+zip",
      "META-INF/container.xml": "<container/>",
      "OEBPS/chapter1.xhtml": "<html/>",
    });
    const result = extractEpubArchive(zip, GENEROUS_LIMITS);
    expect(new TextDecoder().decode(result.get("mimetype"))).toBe("application/epub+zip");
    expect(new TextDecoder().decode(result.get("META-INF/container.xml"))).toBe("<container/>");
    expect(result.size).toBe(3);
  });

  it("returns an empty map for an empty archive (spec §19.1 空archive)", () => {
    const zip = zipSync({});
    const result = extractEpubArchive(zip, GENEROUS_LIMITS);
    expect(result.size).toBe(0);
  });
});

describe("extractEpubArchive: not a ZIP (spec §19.1 ZIPマジック不正)", () => {
  it("rejects bytes with no end-of-central-directory record", () => {
    const notAZip = new TextEncoder().encode("this is not a zip file at all");
    expect(() => extractEpubArchive(notAZip, GENEROUS_LIMITS)).toThrow(EpubError);
    try {
      extractEpubArchive(notAZip, GENEROUS_LIMITS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EpubError);
      expect((error as EpubError).code).toBe("INVALID_ZIP");
      expect((error as EpubError).deterministic).toBe(true);
    }
  });

  it("rejects a buffer too small to contain an EOCD record", () => {
    expect(() => extractEpubArchive(new Uint8Array([1, 2, 3]), GENEROUS_LIMITS)).toThrow(EpubError);
  });
});

describe("extractEpubArchive: path safety (spec §19.1 path traversal / absolute path / backslash path / 重複path)", () => {
  it("rejects a path-traversal entry name", () => {
    const zip = buildEpubZip({ "../evil.txt": "x" });
    expect(() => extractEpubArchive(zip, GENEROUS_LIMITS)).toThrow(EpubError);
    try {
      extractEpubArchive(zip, GENEROUS_LIMITS);
    } catch (error) {
      expect((error as EpubError).code).toBe("UNSAFE_PATH");
    }
  });

  it("rejects a POSIX absolute path", () => {
    const zip = buildEpubZip({ "/etc/passwd": "x" });
    expect(() => extractEpubArchive(zip, GENEROUS_LIMITS)).toThrow(EpubError);
  });

  it("rejects a Windows drive-letter absolute path", () => {
    const zip = buildEpubZip({ "C:/Windows/system.ini": "x" });
    expect(() => extractEpubArchive(zip, GENEROUS_LIMITS)).toThrow(EpubError);
  });

  it("normalizes a backslash path but still rejects traversal through it", () => {
    const zip = buildEpubZip({ "..\\..\\evil.txt": "x" });
    expect(() => extractEpubArchive(zip, GENEROUS_LIMITS)).toThrow(EpubError);
  });

  it("accepts a backslash path that stays inside the archive, normalizing it to forward slashes", () => {
    const zip = buildEpubZip({ "OEBPS\\chapter1.xhtml": "<html/>" });
    const result = extractEpubArchive(zip, GENEROUS_LIMITS);
    expect(result.has("OEBPS/chapter1.xhtml")).toBe(true);
  });

  it("rejects an archive with two entries that normalize to the same path", () => {
    // zipSync's Zippable is a plain object, so two literal keys can't collide
    // at the JS level — construct the duplicate via one backslash and one
    // forward-slash form of the same path instead.
    const zip = buildEpubZip({
      "OEBPS/dup.xhtml": "<html>a</html>",
      "OEBPS\\dup.xhtml": "<html>b</html>",
    });
    expect(() => extractEpubArchive(zip, GENEROUS_LIMITS)).toThrow(EpubError);
    try {
      extractEpubArchive(zip, GENEROUS_LIMITS);
    } catch (error) {
      expect((error as EpubError).code).toBe("UNSAFE_PATH");
    }
  });
});

describe("extractEpubArchive: size/count limits (spec §19.1 エントリ数超過 / 展開後サイズ超過 / 単一entryサイズ超過)", () => {
  it("rejects an archive with more entries than maxEntries", () => {
    const zip = buildEpubZip({ "a.txt": "1", "b.txt": "2", "c.txt": "3" });
    expect(() =>
      extractEpubArchive(zip, { ...GENEROUS_LIMITS, maxEntries: 2 }),
    ).toThrow(EpubError);
    try {
      extractEpubArchive(zip, { ...GENEROUS_LIMITS, maxEntries: 2 });
    } catch (error) {
      expect((error as EpubError).code).toBe("TOO_MANY_ENTRIES");
    }
  });

  it("rejects a single entry larger than maxEntryBytes", () => {
    const zip = buildEpubZip({ "big.txt": "x".repeat(1000) });
    expect(() =>
      extractEpubArchive(zip, { ...GENEROUS_LIMITS, maxEntryBytes: 100 }),
    ).toThrow(EpubError);
    try {
      extractEpubArchive(zip, { ...GENEROUS_LIMITS, maxEntryBytes: 100 });
    } catch (error) {
      expect((error as EpubError).code).toBe("ENTRY_TOO_LARGE");
    }
  });

  it("rejects a total decompressed size over maxTotalUncompressedBytes", () => {
    const zip = buildEpubZip({ "a.txt": "x".repeat(600), "b.txt": "x".repeat(600) });
    expect(() =>
      extractEpubArchive(zip, { ...GENEROUS_LIMITS, maxEntryBytes: 1000, maxTotalUncompressedBytes: 1000 }),
    ).toThrow(EpubError);
    try {
      extractEpubArchive(zip, { ...GENEROUS_LIMITS, maxEntryBytes: 1000, maxTotalUncompressedBytes: 1000 });
    } catch (error) {
      expect((error as EpubError).code).toBe("UNCOMPRESSED_SIZE_TOO_LARGE");
    }
  });

  it("never inflates anything before the size pre-scan rejects an oversized entry (no partial extraction)", () => {
    // A regression guard for design decision D1 ("全部展開してから検証は禁止"):
    // if this ever inflated first, the small entry below would still show up
    // in a partial result instead of the whole call throwing.
    const zip = buildEpubZip({ "small.txt": "ok", "huge.txt": "x".repeat(10_000) });
    expect(() =>
      extractEpubArchive(zip, { ...GENEROUS_LIMITS, maxEntryBytes: 100 }),
    ).toThrow(EpubError);
  });
});

describe("extractEpubArchive: encryption (spec §19.1 暗号化entry)", () => {
  it("rejects an archive containing an encrypted entry", () => {
    const zip = buildEpubZip({ "secret.txt": "top secret" });
    const patched = markEntryEncrypted(zip, "secret.txt");
    expect(() => extractEpubArchive(patched, GENEROUS_LIMITS)).toThrow(EpubError);
    try {
      extractEpubArchive(patched, GENEROUS_LIMITS);
    } catch (error) {
      expect((error as EpubError).code).toBe("ENCRYPTED_EPUB");
    }
  });
});

/** Overwrites the 4-byte signature field 20 bytes before the EOCD record with the ZIP64 EOCD locator signature (APPNOTE.txt §4.3.15) — the exact structure archive.ts checks for at `parseCentralDirectory`'s ZIP64 rejection branch. Only those 4 bytes matter to that check, so this doesn't need to build a structurally valid ZIP64 locator record. */
function insertZip64EocdLocatorSignature(zip: Uint8Array): Uint8Array {
  const patched = Uint8Array.from(zip);
  const view = new DataView(patched.buffer);
  let offset = patched.length - 22;
  while (view.getUint32(offset, true) !== 0x06054b50) {
    offset--;
  }
  view.setUint32(offset - 20, 0x07064b50, true);
  return patched;
}

/** Overwrites the EOCD record's "total entries" field (offset+10) with the ZIP64 sentinel 0xFFFF (APPNOTE.txt §4.3.16) — archive.ts's other ZIP64-rejection branch, distinct from the locator-signature one above (a ZIP64 archive can in principle have one without the other malformed). */
function markEocdEntryCountSentinel(zip: Uint8Array): Uint8Array {
  const patched = Uint8Array.from(zip);
  const view = new DataView(patched.buffer);
  let offset = patched.length - 22;
  while (view.getUint32(offset, true) !== 0x06054b50) {
    offset--;
  }
  view.setUint16(offset + 10, 0xffff, true);
  return patched;
}

/** Overwrites `name`'s central directory compressedSize/uncompressedSize fields with the ZIP64 sentinel 0xFFFFFFFF (the "actual size lives in the ZIP64 extra field" marker) — archive.ts's third ZIP64-rejection branch, per-entry rather than archive-wide. */
function markEntryZip64SizeSentinel(zip: Uint8Array, name: string): Uint8Array {
  const patched = Uint8Array.from(zip);
  const view = new DataView(patched.buffer);
  const offset = findCentralDirectoryRecordOffset(patched, name);
  view.setUint32(offset + 20, 0xffffffff, true);
  view.setUint32(offset + 24, 0xffffffff, true);
  return patched;
}

describe("extractEpubArchive: ZIP64 rejection (spec §19.1 ZIP64拒否, design decision D2)", () => {
  it("rejects an archive with a ZIP64 end-of-central-directory locator", () => {
    const zip = buildEpubZip({ "a.txt": "hello world" });
    const patched = insertZip64EocdLocatorSignature(zip);
    expect(() => extractEpubArchive(patched, GENEROUS_LIMITS)).toThrow(EpubError);
    try {
      extractEpubArchive(patched, GENEROUS_LIMITS);
      expect.unreachable();
    } catch (error) {
      expect((error as EpubError).code).toBe("UNSUPPORTED_ARCHIVE");
    }
  });

  it("rejects an archive whose end-of-central-directory record carries the ZIP64 entry-count sentinel (0xFFFF)", () => {
    const zip = buildEpubZip({ "a.txt": "hello world" });
    const patched = markEocdEntryCountSentinel(zip);
    expect(() => extractEpubArchive(patched, GENEROUS_LIMITS)).toThrow(EpubError);
    try {
      extractEpubArchive(patched, GENEROUS_LIMITS);
      expect.unreachable();
    } catch (error) {
      expect((error as EpubError).code).toBe("UNSUPPORTED_ARCHIVE");
    }
  });

  it("rejects an archive whose central directory entry carries the ZIP64 size sentinel (0xFFFFFFFF)", () => {
    const zip = buildEpubZip({ "a.txt": "hello world" });
    const patched = markEntryZip64SizeSentinel(zip, "a.txt");
    expect(() => extractEpubArchive(patched, GENEROUS_LIMITS)).toThrow(EpubError);
    try {
      extractEpubArchive(patched, GENEROUS_LIMITS);
      expect.unreachable();
    } catch (error) {
      expect((error as EpubError).code).toBe("UNSUPPORTED_ARCHIVE");
    }
  });
});

describe("validateEpubMimetype (spec §8.2, design decision D4)", () => {
  it("accepts an exact match", () => {
    const entries = new Map([["mimetype", new TextEncoder().encode("application/epub+zip")]]);
    expect(() => validateEpubMimetype(entries)).not.toThrow();
  });

  it("accepts ASCII whitespace-trimmed matches (D4's pinned leniency)", () => {
    const entries = new Map([["mimetype", new TextEncoder().encode(" application/epub+zip\n")]]);
    expect(() => validateEpubMimetype(entries)).not.toThrow();
  });

  it("rejects a missing mimetype entry", () => {
    expect(() => validateEpubMimetype(new Map())).toThrow(EpubError);
  });

  it("rejects a value with internal differences (not just leading/trailing whitespace)", () => {
    const entries = new Map([["mimetype", new TextEncoder().encode("Application/Epub+Zip")]]);
    expect(() => validateEpubMimetype(entries)).toThrow(EpubError);
  });

  it("rejects a mimetype entry with a byte-order mark (BOM is not ASCII whitespace)", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const rest = new TextEncoder().encode("application/epub+zip");
    const withBom = new Uint8Array(bom.length + rest.length);
    withBom.set(bom, 0);
    withBom.set(rest, bom.length);
    const entries = new Map([["mimetype", withBom]]);
    expect(() => validateEpubMimetype(entries)).toThrow(EpubError);
  });
});

describe("resolveEpubRelativePath", () => {
  it("resolves a same-directory relative href", () => {
    expect(resolveEpubRelativePath("OEBPS/content.opf", "chapter1.xhtml")).toBe(
      "OEBPS/chapter1.xhtml",
    );
  });

  it("resolves a parent-relative href within the archive", () => {
    expect(resolveEpubRelativePath("OEBPS/text/chapter1.xhtml", "../Images/cover.jpg")).toBe(
      "OEBPS/Images/cover.jpg",
    );
  });

  it("rejects an href that escapes the archive root", () => {
    expect(() => resolveEpubRelativePath("OEBPS/content.opf", "../../etc/passwd")).toThrow(
      EpubError,
    );
  });

  it("resolves a root-relative href (leading slash) against the archive root, not the base directory", () => {
    expect(resolveEpubRelativePath("OEBPS/content.opf", "/OEBPS/cover.jpg")).toBe(
      "OEBPS/cover.jpg",
    );
  });

  it("URL-decodes the href before resolving", () => {
    expect(resolveEpubRelativePath("OEBPS/content.opf", "cover%20image.jpg")).toBe(
      "OEBPS/cover image.jpg",
    );
  });
});

describe("resolver defaults (spec §5)", () => {
  it("resolveMaxEpubEntries defaults to 5000 and honors an override", () => {
    expect(resolveMaxEpubEntries({})).toBe(5000);
    expect(resolveMaxEpubEntries({ MAX_EPUB_ENTRIES: "10" })).toBe(10);
    expect(resolveMaxEpubEntries({ MAX_EPUB_ENTRIES: "not-a-number" })).toBe(5000);
  });

  it("resolveMaxEpubEntryBytes defaults to 32 MiB and honors an override", () => {
    expect(resolveMaxEpubEntryBytes({})).toBe(33_554_432);
    expect(resolveMaxEpubEntryBytes({ MAX_EPUB_ENTRY_BYTES: "1000" })).toBe(1000);
  });

  it("resolveMaxEpubUncompressedBytes defaults to 192 MiB and honors an override", () => {
    expect(resolveMaxEpubUncompressedBytes({})).toBe(201_326_592);
    expect(resolveMaxEpubUncompressedBytes({ MAX_EPUB_UNCOMPRESSED_BYTES: "1000" })).toBe(1000);
  });
});
