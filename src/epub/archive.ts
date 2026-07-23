// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { unzipSync } from "fflate";
import type { Unzipped } from "fflate";
import type { Env } from "../types";
import { EpubError } from "./errors";

/**
 * Safe ZIP extraction for uploaded EPUBs (EPUB spec §8.1, design decision
 * D1/D2). fflate's public unzipSync `filter` callback only exposes
 * name/size/originalSize/compression per entry (fflate/lib/index.d.ts's
 * UnzipFileInfo) — it does NOT expose the ZIP general-purpose bit flag, so
 * encryption can't be detected from the filter alone. This module instead
 * parses the ZIP central directory itself first (readCentralDirectory
 * below), entirely from the declared sizes/flags — no inflate happens
 * before every entry has already passed every limit/safety check — and only
 * then calls unzipSync with a filter that re-checks each entry against that
 * pre-validated set (belt-and-suspenders against the two parsers disagreeing
 * on where an entry lives in the buffer).
 *
 * ZIP central directory record layout (APPNOTE.txt §4.3.12), offsets
 * relative to the record start `o`:
 *   0-3   signature (0x02014b50)      20-23 compressed size
 *   8-9   general purpose bit flag    24-27 uncompressed size
 *   10-11 compression method          28-29 file name length (n)
 *                                     30-31 extra field length (m)
 *                                     32-33 file comment length (k)
 *   46..46+n        file name
 *   46+n..46+n+m    extra field
 *   46+n+m..+k      file comment
 */

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_RECORD_SIZE = 22;
const MAX_EOCD_COMMENT = 65535;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
/** ZIP64 sentinel value: "the real value is in the zip64 extra field". */
const ZIP64_SENTINEL_32 = 0xffffffff;
/** Built via fromCharCode rather than a "\0"-style literal escape to keep this plain-ASCII source text. */
const NUL = String.fromCharCode(0);

function dataViewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndOfCentralDirectoryOffset(bytes: Uint8Array): number {
  if (bytes.length < EOCD_RECORD_SIZE) {
    throw new EpubError("INVALID_ZIP", "buffer too small to be a ZIP archive");
  }
  const view = dataViewOf(bytes);
  const minOffset = Math.max(0, bytes.length - EOCD_RECORD_SIZE - MAX_EOCD_COMMENT);
  for (let offset = bytes.length - EOCD_RECORD_SIZE; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new EpubError("INVALID_ZIP", "end of central directory record not found");
}

/**
 * Matches fflate's own strFromU8: UTF-8 when the general-purpose bit-11
 * "language encoding" flag is set, otherwise a byte-for-byte Latin-1
 * mapping. Exact fidelity for malformed byte sequences isn't required here
 * — a decode divergence from fflate's own dutf8() only ever produces a name
 * that then fails to match anything in the filter (safe rejection, not a
 * bypass, since nothing is extracted before every entry passed validation).
 */
function decodeZipEntryName(bytes: Uint8Array, isUtf8: boolean): string {
  if (isUtf8) {
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  }
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
}

interface RawZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Parses the ZIP central directory only (never touches local file header
 * data, never inflates anything). Throws EpubError for every condition spec
 * §8.1/§19.1 requires to be rejected before any content is extracted:
 * ZIP64 (D2, explicit reject rather than trusting fflate's partial support),
 * encrypted entries (general-purpose bit 0), entry-count overflow, and any
 * structural inconsistency.
 */
function parseCentralDirectory(bytes: Uint8Array, maxEntries: number): RawZipEntry[] {
  const view = dataViewOf(bytes);
  const eocdOffset = findEndOfCentralDirectoryOffset(bytes);

  // A ZIP64 EOCD locator sits exactly 20 bytes before a standard EOCD record
  // when present (APPNOTE.txt §4.3.15); fflate itself branches on this same
  // signature to widen its own reads. Reject explicitly (D2) instead of
  // trusting either parser's zip64 handling for an untrusted upload.
  if (eocdOffset >= 20 && view.getUint32(eocdOffset - 20, true) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    throw new EpubError("UNSUPPORTED_ARCHIVE", "zip64 end-of-central-directory locator present");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (
    totalEntries === 0xffff ||
    centralDirSize === ZIP64_SENTINEL_32 ||
    centralDirOffset === ZIP64_SENTINEL_32
  ) {
    throw new EpubError("UNSUPPORTED_ARCHIVE", "zip64 sentinel value in end-of-central-directory record");
  }
  if (totalEntries > maxEntries) {
    throw new EpubError("TOO_MANY_ENTRIES");
  }
  if (centralDirOffset > eocdOffset || centralDirOffset + centralDirSize > eocdOffset) {
    throw new EpubError("INVALID_ZIP", "central directory extends past end-of-central-directory record");
  }

  const entries: RawZipEntry[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (offset + CENTRAL_DIRECTORY_HEADER_SIZE > bytes.length) {
      throw new EpubError("INVALID_ZIP", "truncated central directory entry");
    }
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new EpubError("INVALID_ZIP", "bad central directory entry signature");
    }

    const generalPurposeFlag = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const filenameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);

    // Bit 0 of the general-purpose flag: this entry's data is encrypted
    // (traditional PKWARE or strong encryption alike — either way fflate
    // cannot safely inflate it). Reject the whole archive (D2), not just
    // this entry: an EPUB with even one encrypted resource can't be
    // rendered faithfully.
    if ((generalPurposeFlag & 0x1) !== 0) {
      throw new EpubError("ENCRYPTED_EPUB");
    }
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32) {
      throw new EpubError("UNSUPPORTED_ARCHIVE", "zip64 entry size sentinel");
    }

    const nameStart = offset + CENTRAL_DIRECTORY_HEADER_SIZE;
    const nameEnd = nameStart + filenameLen;
    if (nameEnd > bytes.length) {
      throw new EpubError("INVALID_ZIP", "truncated entry file name");
    }
    const isUtf8 = (generalPurposeFlag & 0x800) !== 0;
    const name = decodeZipEntryName(bytes.subarray(nameStart, nameEnd), isUtf8);

    entries.push({ name, compression, compressedSize, uncompressedSize });
    offset = nameEnd + extraLen + commentLen;
  }

  return entries;
}

/**
 * Normalizes one ZIP entry name per spec §8.1: backslash → "/", reject NUL,
 * reject absolute paths (POSIX "/..." and Windows "C:...") and any ".."
 * path segment. Also used by resolveEpubRelativePath below for reference
 * resolution (container.xml rootfile, OPF manifest hrefs, etc.) — the same
 * traversal defense applies to both "names baked into the ZIP" and
 * "references found inside EPUB documents".
 */
function normalizeZipEntryPath(rawName: string): string {
  if (rawName.length === 0) {
    throw new EpubError("UNSAFE_PATH", "empty entry name");
  }
  if (rawName.includes(NUL)) {
    throw new EpubError("UNSAFE_PATH", "NUL byte in entry name");
  }
  const normalized = rawName.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new EpubError("UNSAFE_PATH", "absolute path");
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new EpubError("UNSAFE_PATH", "drive-letter absolute path");
  }
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new EpubError("UNSAFE_PATH", "path traversal segment");
    }
  }
  return normalized;
}

export interface EpubArchiveLimits {
  maxEntries: number;
  /** Per-entry decompressed size cap. */
  maxEntryBytes: number;
  /** Sum of every (non-directory) entry's decompressed size. */
  maxTotalUncompressedBytes: number;
}

interface SafeZipEntry {
  /** Normalized (backslash→"/") path — the key `result`/duplicate-detection use, distinct from the raw ZIP entry name fflate's filter callback reports. */
  normalizedPath: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Extracts an uploaded EPUB's ZIP entries, enforcing every safety condition
 * in spec §8.1 before any bytes are inflated: path safety, duplicate paths,
 * entry-count/size limits (both per-entry and cumulative — computed from the
 * central directory's *declared* sizes, so a bomb is rejected before
 * unzipSync ever runs), and encryption/zip64 rejection. Directory entries
 * (names ending in "/") are recognized but never included in the result
 * (spec: "directory entry を本文として扱わない").
 *
 * Deliberately never calls the plain `unzipSync(data)` form (whole-archive,
 * no filter) — see design decision D1's "「全部展開してから検証」は禁止".
 */
export function extractEpubArchive(
  bytes: Uint8Array,
  limits: EpubArchiveLimits,
): Map<string, Uint8Array> {
  const rawEntries = parseCentralDirectory(bytes, limits.maxEntries);

  // Keyed by the RAW entry name (exactly as fflate's own filter callback
  // reports it via `file.name`) — NOT the normalized path, since fflate/ZIP
  // itself never normalizes backslashes. seenNormalizedPaths is the separate
  // duplicate-detection set, keyed by the normalized path.
  const safeEntriesByRawName = new Map<string, SafeZipEntry>();
  const seenNormalizedPaths = new Set<string>();
  let totalUncompressed = 0;

  for (const entry of rawEntries) {
    const normalizedPath = normalizeZipEntryPath(entry.name);

    if (seenNormalizedPaths.has(normalizedPath)) {
      throw new EpubError("UNSAFE_PATH", "duplicate normalized entry path");
    }
    seenNormalizedPaths.add(normalizedPath);

    if (normalizedPath.endsWith("/")) {
      continue; // directory entry — never content (spec §8.1)
    }

    if (entry.compression !== 0 && entry.compression !== 8) {
      throw new EpubError("UNSUPPORTED_ARCHIVE", `compression method ${entry.compression}`);
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw new EpubError("ENTRY_TOO_LARGE");
    }
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new EpubError("UNCOMPRESSED_SIZE_TOO_LARGE");
    }

    safeEntriesByRawName.set(entry.name, {
      normalizedPath,
      compression: entry.compression,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    });
  }

  let extracted: Unzipped;
  try {
    extracted = unzipSync(bytes, {
      filter: (file) => {
        const meta = safeEntriesByRawName.get(file.name);
        if (meta === undefined) {
          return false;
        }
        if (
          file.compression !== meta.compression ||
          file.size !== meta.compressedSize ||
          file.originalSize !== meta.uncompressedSize
        ) {
          // Our central-directory pre-scan and fflate's own independent
          // parse disagree on this entry — the archive is either malformed
          // or crafted to desync the two parsers. Reject outright.
          throw new EpubError("INVALID_ZIP", "central directory / decoder mismatch");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof EpubError) {
      throw error;
    }
    throw new EpubError(
      "INVALID_ZIP",
      error instanceof Error ? error.message : "unknown unzip failure",
    );
  }

  const result = new Map<string, Uint8Array>();
  for (const [rawName, meta] of safeEntriesByRawName) {
    const data = extracted[rawName];
    if (data === undefined) {
      throw new EpubError("INVALID_ZIP", "expected entry missing after extraction");
    }
    result.set(meta.normalizedPath, data);
  }
  return result;
}

const EXPECTED_MIMETYPE = "application/epub+zip";

/**
 * Validates the root `mimetype` entry (spec §8.2). Exact match after
 * trimming ASCII whitespace only — no BOM stripping, no case-insensitivity
 * (design decision D4). This leniency rule is pinned by test.
 */
export function validateEpubMimetype(entries: Map<string, Uint8Array>): void {
  const bytes = entries.get("mimetype");
  if (bytes === undefined) {
    throw new EpubError("INVALID_MIMETYPE", "mimetype entry missing");
  }
  // ignoreBOM: true keeps a leading BOM as a literal U+FEFF character in the
  // decoded text instead of TextDecoder's default silent-strip behavior —
  // required so a BOM'd mimetype entry actually fails the equality check
  // below rather than being invisibly accepted (D4: BOM is deliberately NOT
  // part of the ASCII-whitespace trim leniency).
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  const trimmed = text.replace(/^[ \t\r\n\f\v]+/, "").replace(/[ \t\r\n\f\v]+$/, "");
  if (trimmed !== EXPECTED_MIMETYPE) {
    throw new EpubError("INVALID_MIMETYPE", "unexpected mimetype value");
  }
}

/**
 * Resolves `href` (a relative or root-relative reference found inside
 * container.xml/OPF) against `basePath` (the POSIX path of the referencing
 * document within the archive), collapsing "." and ".." segments — the
 * ZIP-Slip-equivalent check for *reference* resolution (spec §8.5: "URLデコ
 * ード後のパスがarchive外へ出る場合は拒否する"), separate from
 * extractEpubArchive's check on the entry names themselves. `href` must not
 * carry a fragment/query — callers with anchors (navigation.ts) strip those
 * first and re-append after resolving the path part.
 */
export function resolveEpubRelativePath(basePath: string, href: string): string {
  let decodedHref: string;
  try {
    decodedHref = decodeURIComponent(href);
  } catch {
    throw new EpubError("UNSAFE_PATH", "malformed percent-encoding in href");
  }
  if (decodedHref.includes(NUL)) {
    throw new EpubError("UNSAFE_PATH", "NUL byte in href");
  }
  const normalizedHref = decodedHref.replace(/\\/g, "/");
  const baseDir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
  const combined = normalizedHref.startsWith("/")
    ? normalizedHref.slice(1)
    : baseDir.length > 0
      ? `${baseDir}/${normalizedHref}`
      : normalizedHref;

  const outputSegments: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (outputSegments.length === 0) {
        throw new EpubError("UNSAFE_PATH", "reference escapes archive root");
      }
      outputSegments.pop();
      continue;
    }
    outputSegments.push(segment);
  }
  if (outputSegments.length === 0) {
    throw new EpubError("UNSAFE_PATH", "reference resolves to the archive root itself");
  }
  return outputSegments.join("/");
}

const DEFAULT_MAX_EPUB_ENTRIES = 5000;
const DEFAULT_MAX_EPUB_ENTRY_BYTES = 33_554_432; // 32 MiB
const DEFAULT_MAX_EPUB_UNCOMPRESSED_BYTES = 201_326_592; // 192 MiB

/** Max ZIP central-directory entry count; the MAX_EPUB_ENTRIES var overrides the default 5000. */
export function resolveMaxEpubEntries(env: Pick<Env, "MAX_EPUB_ENTRIES">): number {
  const configured = Number(env.MAX_EPUB_ENTRIES);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_EPUB_ENTRIES;
}

/** Max decompressed size of a single entry; the MAX_EPUB_ENTRY_BYTES var overrides the default 32 MiB. */
export function resolveMaxEpubEntryBytes(env: Pick<Env, "MAX_EPUB_ENTRY_BYTES">): number {
  const configured = Number(env.MAX_EPUB_ENTRY_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_EPUB_ENTRY_BYTES;
}

/** Max total decompressed size across all entries; the MAX_EPUB_UNCOMPRESSED_BYTES var overrides the default 192 MiB. */
export function resolveMaxEpubUncompressedBytes(
  env: Pick<Env, "MAX_EPUB_UNCOMPRESSED_BYTES">,
): number {
  const configured = Number(env.MAX_EPUB_UNCOMPRESSED_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_EPUB_UNCOMPRESSED_BYTES;
}
