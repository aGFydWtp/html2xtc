// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Stable EPUB parsing error codes and the error type carrying them (EPUB
 * spec §17.1). Kept free of "cloudflare:workflows" so this module — and
 * every src/epub/* module that only throws EpubError — stays importable
 * under plain vitest; Phase 4 (src/workflow.ts) is the one place that
 * decides whether to re-throw as a NonRetryableError, using the
 * `deterministic` flag below (design decision D5).
 */
export type EpubErrorCode =
  | "INVALID_ZIP"
  | "INVALID_MIMETYPE"
  | "MISSING_CONTAINER"
  | "INVALID_CONTAINER"
  | "MISSING_PACKAGE"
  | "INVALID_PACKAGE"
  | "EMPTY_SPINE"
  | "MISSING_SPINE_ITEM"
  | "ENCRYPTED_EPUB"
  | "FIXED_LAYOUT_UNSUPPORTED"
  | "TOO_MANY_ENTRIES"
  | "ENTRY_TOO_LARGE"
  | "UNCOMPRESSED_SIZE_TOO_LARGE"
  | "HTML_TOO_LARGE"
  | "UNSAFE_PATH"
  | "UNSUPPORTED_ARCHIVE";

/**
 * Client-safe messages (spec §17): never the EPUB's original text, HTML, or
 * internal archive paths — only these fixed strings. Several codes
 * deliberately share a message where the spec's own table does (e.g. every
 * size-limit code maps to "EPUB is too large to convert").
 */
const EPUB_ERROR_MESSAGES: Record<EpubErrorCode, string> = {
  INVALID_ZIP: "invalid EPUB file",
  INVALID_MIMETYPE: "invalid EPUB file",
  MISSING_CONTAINER: "EPUB package information is missing",
  INVALID_CONTAINER: "EPUB package information is missing",
  MISSING_PACKAGE: "EPUB package information is missing",
  INVALID_PACKAGE: "EPUB package information is missing",
  EMPTY_SPINE: "EPUB contains no readable content",
  MISSING_SPINE_ITEM: "EPUB contains no readable content",
  ENCRYPTED_EPUB: "encrypted EPUB is not supported",
  FIXED_LAYOUT_UNSUPPORTED: "fixed-layout EPUB is not supported",
  TOO_MANY_ENTRIES: "EPUB is too large to convert",
  ENTRY_TOO_LARGE: "EPUB is too large to convert",
  UNCOMPRESSED_SIZE_TOO_LARGE: "EPUB is too large to convert",
  HTML_TOO_LARGE: "EPUB is too large to convert",
  UNSAFE_PATH: "invalid EPUB file",
  UNSUPPORTED_ARCHIVE: "invalid EPUB file",
};

/**
 * Every code this module currently defines describes a property of the
 * uploaded bytes (malformed/encrypted/oversized/unsupported-shape) — never a
 * transient dependency (R2, network) — so retrying the same EPUB can never
 * turn a rejection into a success. Written as an explicit allowlist (rather
 * than "EpubError is always non-retryable") so a code added later without
 * updating this set fails safe as retryable instead of silently becoming a
 * NonRetryableError that would swallow a real platform hiccup.
 */
const DETERMINISTIC_ERROR_CODES: ReadonlySet<EpubErrorCode> = new Set<EpubErrorCode>([
  "INVALID_ZIP",
  "INVALID_MIMETYPE",
  "MISSING_CONTAINER",
  "INVALID_CONTAINER",
  "MISSING_PACKAGE",
  "INVALID_PACKAGE",
  "EMPTY_SPINE",
  "MISSING_SPINE_ITEM",
  "ENCRYPTED_EPUB",
  "FIXED_LAYOUT_UNSUPPORTED",
  "TOO_MANY_ENTRIES",
  "ENTRY_TOO_LARGE",
  "UNCOMPRESSED_SIZE_TOO_LARGE",
  "HTML_TOO_LARGE",
  "UNSAFE_PATH",
  "UNSUPPORTED_ARCHIVE",
]);

export class EpubError extends Error {
  readonly code: EpubErrorCode;
  /** True when retrying with the same input bytes can never succeed (spec §14.1.1, design decision D5). */
  readonly deterministic: boolean;
  /** Client-safe message (spec §17) — safe to put straight into a 4xx JSON body. */
  readonly clientMessage: string;

  /**
   * `detail` is for logs only (console.error, never a Response body) and
   * must stay structural — never EPUB original text/HTML/paths (spec §17).
   */
  constructor(code: EpubErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "EpubError";
    this.code = code;
    this.clientMessage = EPUB_ERROR_MESSAGES[code];
    this.deterministic = DETERMINISTIC_ERROR_CODES.has(code);
  }
}

/**
 * XXE defense-in-depth (design decision D3): linkedom's DOMParser never
 * resolves external entities or fetches a DTD, but a string-level check
 * ahead of parsing is required regardless — reject before the parser ever
 * sees the bytes, rather than relying solely on the parser's own behavior.
 */
export function assertNoXxeMarkers(xml: string, code: EpubErrorCode): void {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new EpubError(code, "DOCTYPE/ENTITY marker present");
  }
}
