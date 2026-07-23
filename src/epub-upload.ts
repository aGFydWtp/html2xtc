// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { decodeBase64Url } from "./base64url";
import type { Env } from "./types";

/**
 * POST /jobs/epub support (EPUB_TO_XTC_IMPLEMENTATION_SPEC.md §7): header
 * validation, ZIP-magic sniffing, and the streamed R2 save. Mirrors
 * src/pdf-upload.ts's / src/text-upload.ts's split — the route handler
 * itself (src/index.ts#handleCreateEpubJob) stays in index.ts next to the
 * other job-creation handlers and is the only piece of this feature that
 * touches enforceRateLimit / CONVERT_WORKFLOW.create; everything here is
 * either pure or R2-only, so it stays importable (and unit-testable) under
 * plain vitest without pulling in a "cloudflare:workers" runtime import (see
 * src/pdf-upload.ts's identical doc comment about the same constraint).
 *
 * Response bodies use the legacy `{"error": "<string>"}` shape, matching
 * every other job-creation endpoint in this codebase. Deep EPUB structure
 * validation (container.xml/OPF/spine/encryption/Fixed Layout) is
 * deliberately NOT done here — spec §7.2 is explicit that a ZIP magic check
 * alone doesn't confirm a valid EPUB, and that full validation happens in
 * the Workflow's prepare-epub step (src/epub/*), which can read the file
 * back from R2 in full rather than buffering it here.
 */

const ALLOWED_EPUB_CONTENT_TYPES = new Set(["application/epub+zip", "application/octet-stream"]);

/**
 * Content-Type check (spec §7.1): application/epub+zip is always accepted;
 * application/octet-stream is only accepted when `filename` ends in .epub
 * (case-insensitive) — unlike the PDF/TXT uploads, this one extra condition
 * is spelled out explicitly in the spec, so filename must already be decoded
 * by the time this runs (handleCreateEpubJob decodes X-File-Name before
 * calling this, ahead of where PDF/TXT decode it — X-File-Name can never
 * itself produce an error, see decodeFilenameHeader-style degrade-to-default
 * below, so reordering it earlier changes no error precedence).
 */
export function isAllowedEpubContentType(headerValue: string | null, filename: string): boolean {
  if (headerValue === null) {
    return false;
  }
  const mediaType = headerValue.split(";")[0]?.trim().toLowerCase();
  if (mediaType === undefined || !ALLOWED_EPUB_CONTENT_TYPES.has(mediaType)) {
    return false;
  }
  if (mediaType === "application/octet-stream") {
    return filename.toLowerCase().endsWith(".epub");
  }
  return true;
}

const DEFAULT_MAX_UPLOAD_EPUB_BYTES = 50_331_648; // 48 MiB (spec §5)

/** Max upload size; the MAX_UPLOAD_EPUB_BYTES var overrides the 48 MiB default. */
export function resolveMaxUploadEpubBytes(
  env: Pick<Env, "MAX_UPLOAD_EPUB_BYTES">,
): number {
  const configured = Number(env.MAX_UPLOAD_EPUB_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_EPUB_BYTES;
}

const DEFAULT_EPUB_FILENAME = "document.epub";
const MAX_FILENAME_CHARS = 255;

/**
 * Sanitizes a decoded X-File-Name value: strip control characters and path
 * separators, NFC-normalize, cap at 255 code points, fall back to
 * "document.epub" when empty, append ".epub" when no extension is present.
 * Display/XTC-title use only — never a path or R2 key. Mirrors
 * sanitizeUploadFilename (src/pdf-upload.ts) / sanitizeUploadTextFilename
 * (src/text-upload.ts) exactly.
 */
export function sanitizeUploadEpubFilename(raw: string): string {
  const withoutControlChars = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const isC0 = code < 0x20;
      const isDel = code === 0x7f;
      return !isC0 && !isDel;
    })
    .join("");
  const cleaned = withoutControlChars
    .replace(/[/\\]/g, "")
    .normalize("NFC")
    .trim();
  if (cleaned.length === 0) {
    return DEFAULT_EPUB_FILENAME;
  }
  const capped = Array.from(cleaned).slice(0, MAX_FILENAME_CHARS).join("");
  if (capped.length === 0) {
    return DEFAULT_EPUB_FILENAME;
  }
  return /\.[^./\\]+$/.test(capped) ? capped : `${capped}.epub`;
}

/**
 * Decodes X-File-Name. Like the PDF/TXT paths, a missing or undecodable
 * header is not a client error — it degrades to the default filename.
 */
export function decodeEpubFilenameHeader(headerValue: string | null): string {
  if (headerValue === null) {
    return DEFAULT_EPUB_FILENAME;
  }
  const decoded = decodeBase64Url(headerValue);
  return decoded === null ? DEFAULT_EPUB_FILENAME : sanitizeUploadEpubFilename(decoded);
}

/**
 * ZIP local-file-header / empty-archive / spanned-archive magic numbers
 * (spec §7.2). Confirms the upload is *some* ZIP, not that it's a valid
 * EPUB — src/epub/archive.ts's central-directory parse (prepare-epub step)
 * is the real gate.
 */
const ZIP_MAGICS: readonly (readonly [number, number, number, number])[] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

export function hasEpubZipMagic(leadingBytes: Uint8Array): boolean {
  if (leadingBytes.byteLength < 4) {
    return false;
  }
  return ZIP_MAGICS.some((magic) => magic.every((byte, i) => leadingBytes[i] === byte));
}

export interface PeekedBody {
  /** Up to `minBytes` bytes from the start of the stream (fewer if the stream was shorter). */
  leading: Uint8Array;
  /** A stream that replays the exact original bytes (leading chunks + the rest), byte-for-byte. */
  body: ReadableStream<Uint8Array>;
}

/**
 * Reads enough leading chunks from `body` to inspect the first `minBytes`
 * bytes (for the ZIP magic check), then returns a reconstructed stream that
 * replays those buffered chunks followed by the rest of the original reader
 * — so the caller can still stream the *entire, untouched* body into R2
 * afterwards (never buffering the whole upload, spec §7.3/§10.3's "never
 * request.arrayBuffer()" stance shared with the PDF/TXT uploads).
 */
export async function peekLeadingBytes(
  body: ReadableStream<Uint8Array>,
  minBytes: number,
): Promise<PeekedBody> {
  const reader = body.getReader();
  const buffered: Uint8Array[] = [];
  let total = 0;
  while (total < minBytes) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffered.push(value);
    total += value.byteLength;
  }

  const leading = new Uint8Array(Math.min(total, minBytes));
  let offset = 0;
  for (const chunk of buffered) {
    const take = Math.min(chunk.byteLength, leading.byteLength - offset);
    if (take <= 0) {
      break;
    }
    leading.set(chunk.subarray(0, take), offset);
    offset += take;
  }

  const replay = buffered.slice();
  const rebuilt = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = replay.shift();
      if (next !== undefined) {
        controller.enqueue(next);
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return { leading, body: rebuilt };
}

async function deleteBestEffort(env: Pick<Env, "XTC_BUCKET">, key: string): Promise<void> {
  try {
    await env.XTC_BUCKET.delete(key);
  } catch (error) {
    console.error(`best-effort delete of ${key} failed`, error);
  }
}

export type SaveUploadedEpubResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Streams `body` into R2 at `key` and verifies the stored size against the
 * declared Content-Length (spec §7.3/§18's "Content-Lengthと保存サイズを照合
 * する"): never buffers the whole EPUB into a Worker-side ArrayBuffer. On any
 * failure the (possibly partial) R2 object is deleted before returning, and
 * the caller is expected to not start a Workflow.
 */
export async function saveUploadedEpub(
  env: Pick<Env, "XTC_BUCKET">,
  key: string,
  body: ReadableStream,
  declaredSize: number,
  filename: string,
): Promise<SaveUploadedEpubResult> {
  try {
    await env.XTC_BUCKET.put(key, body, {
      httpMetadata: { contentType: "application/epub+zip" },
      customMetadata: { filename, sourceType: "epub" },
    });
  } catch (error) {
    console.error(`R2 put ${key} failed`, error);
    await deleteBestEffort(env, key);
    return { ok: false, status: 500, error: "failed to store upload" };
  }

  const stored = await env.XTC_BUCKET.head(key);
  if (stored === null || stored.size !== declaredSize) {
    console.error(
      `stored size ${stored?.size ?? "missing"} for ${key} != declared Content-Length ${declaredSize}`,
    );
    await deleteBestEffort(env, key);
    return {
      ok: false,
      status: 400,
      error: "uploaded EPUB size does not match Content-Length",
    };
  }

  return { ok: true };
}
