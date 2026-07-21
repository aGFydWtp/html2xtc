// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { decodeBase64Url } from "./base64url";
import {
  BinaryTextFileError,
  EncodingDetectionFailedError,
  Utf16NotSupportedError,
} from "./text-decode";
import { EmptyTextError, LineTooLongError, TextTooLongError, TooManyLinesError } from "./text-normalize";
import type { Env } from "./types";

/**
 * POST /jobs/text support (text-upload spec §11): header validation and the
 * streamed R2 save. Mirrors src/pdf-upload.ts's split — the route handler
 * itself (src/index.ts#handleCreateTextJob) stays in index.ts next to the
 * other job-creation handlers and is the only piece of this feature that
 * touches enforceRateLimit / CONVERT_WORKFLOW.create; everything here is
 * either pure or R2-only, so it stays importable under plain vitest (see
 * src/pdf-upload.ts's identical doc comment about the same constraint).
 *
 * Response bodies use the legacy `{"error": "<string>"}` shape, matching
 * every other job-creation endpoint in this codebase.
 */

const ALLOWED_TEXT_CONTENT_TYPES = new Set(["text/plain", "application/octet-stream"]);

/**
 * Content-Type check (spec §11.2): text/plain or application/octet-stream,
 * media-type parameters ignored, case-insensitive. Unlike the PDF path this
 * can't gate application/octet-stream on "extension/content validation
 * succeeded" at this point in the request — spec §13.3 forbids buffering the
 * body here (it streams straight to R2), so the actual binary/encoding
 * checks the spec describes for octet-stream run later, in the prepare-text
 * Workflow step, once the (size-bounded) file is read back from R2.
 */
export function isAllowedTextContentType(headerValue: string | null): boolean {
  if (headerValue === null) {
    return false;
  }
  const mediaType = headerValue.split(";")[0]?.trim().toLowerCase();
  return mediaType !== undefined && ALLOWED_TEXT_CONTENT_TYPES.has(mediaType);
}

const DEFAULT_TEXT_FILENAME = "document.txt";
const MAX_FILENAME_CHARS = 255;

/**
 * Sanitizes a decoded X-File-Name value per spec §11.4: strip control
 * characters and path separators, NFC-normalize, cap at 255 code points,
 * fall back to "document.txt" when empty, append ".txt" when no extension is
 * present. Display/XTC-title use only — never a path or R2 key.
 */
export function sanitizeUploadTextFilename(raw: string): string {
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
    return DEFAULT_TEXT_FILENAME;
  }
  const capped = Array.from(cleaned).slice(0, MAX_FILENAME_CHARS).join("");
  if (capped.length === 0) {
    return DEFAULT_TEXT_FILENAME;
  }
  return /\.[^./\\]+$/.test(capped) ? capped : `${capped}.txt`;
}

/**
 * Decodes X-File-Name. Like the PDF path, a missing or undecodable header is
 * not a client error — it degrades to the default filename.
 */
export function decodeTextFilenameHeader(headerValue: string | null): string {
  if (headerValue === null) {
    return DEFAULT_TEXT_FILENAME;
  }
  const decoded = decodeBase64Url(headerValue);
  return decoded === null ? DEFAULT_TEXT_FILENAME : sanitizeUploadTextFilename(decoded);
}

async function deleteBestEffort(env: Pick<Env, "XTC_BUCKET">, key: string): Promise<void> {
  try {
    await env.XTC_BUCKET.delete(key);
  } catch (error) {
    console.error(`best-effort delete of ${key} failed`, error);
  }
}

export type SaveUploadedTextResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Streams `body` into R2 at `key` and verifies the stored size against the
 * declared Content-Length (spec §13.3): never buffers the whole file into a
 * Worker-side ArrayBuffer. On any failure the (possibly partial) R2 object is
 * deleted before returning, and the caller must not start a Workflow.
 */
export async function saveUploadedText(
  env: Pick<Env, "XTC_BUCKET">,
  key: string,
  body: ReadableStream,
  declaredSize: number,
  filename: string,
): Promise<SaveUploadedTextResult> {
  try {
    await env.XTC_BUCKET.put(key, body, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { filename, sourceType: "txt" },
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
      error: "uploaded text file size does not match Content-Length",
    };
  }

  return { ok: true };
}

/**
 * Maps a prepare-text step failure (src/workflow.ts) to a stable English
 * NonRetryableError message (spec §19.1's condition list: 文字コード不明/
 * UTF-16/バイナリ/文字数超過/行数超過/空ファイル). frontend/src/lib/
 * server-error-text.ts is expected to match these exact strings the same way
 * it already matches src/pdf-upload.ts#uploadedPdfErrorMessage's output —
 * see this repo's PDF equivalent for the established pattern. Falls back to
 * a generic conversion-failed message for anything unrecognized (should
 * never happen for errors actually thrown by src/text-decode.ts /
 * src/text-normalize.ts, but keeps this function total).
 */
export function textPrepareErrorMessage(error: unknown): string {
  if (error instanceof Utf16NotSupportedError) {
    return "UTF-16 is not supported; convert the file to UTF-8";
  }
  if (error instanceof BinaryTextFileError) {
    return "uploaded file is not a plain text file";
  }
  if (error instanceof EncodingDetectionFailedError) {
    return "unable to determine the text encoding";
  }
  if (error instanceof EmptyTextError) {
    return "text file is empty";
  }
  if (error instanceof TextTooLongError) {
    return "text is too long to convert";
  }
  if (error instanceof TooManyLinesError) {
    return "line count exceeds the limit";
  }
  if (error instanceof LineTooLongError) {
    return "a line exceeds the maximum line length";
  }
  return "failed to convert text to XTC";
}
