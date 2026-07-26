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
 * XXE defense-in-depth (design decision D3, narrowed 2026-07-26 — real-world
 * repro: 河童.epub, a 青空文庫-conversion-toolchain EPUB whose nav.xhtml /
 * every XHTML file opens with a plain `<!DOCTYPE html>`). The actual XXE
 * attack surface is (a) an ENTITY declaration (billion-laughs, or an
 * external general/parameter entity used to exfiltrate or fetch something),
 * and (b) a DOCTYPE that itself names an external subset (`SYSTEM`/`PUBLIC`,
 * which points a vulnerable parser at a filesystem or network fetch) or
 * declares an internal subset (`[...]`) — the only place a *local* ENTITY
 * declaration can legally live. A DOCTYPE with neither of those — bare
 * `<!DOCTYPE name>`, no external identifier, no internal subset — carries
 * none of that risk: it cannot declare an entity, and it names nothing for a
 * parser to fetch. The old rule rejected on `<!DOCTYPE` alone, so this bare,
 * harmless form was indistinguishable from a dangerous one; in
 * navigation.ts specifically that meant parseEpubNavigation's catch-all
 * (spec §8.7) silently swallowed the resulting EpubError and degraded to
 * `{ source: "none", entries: [] }` — zero XTC chapters, with no warning
 * (see the accompanying navigation.ts XTC_TOC_PARSE_FAILED warning, added
 * alongside this change) — even though the document was perfectly safe to
 * read.
 *
 * Why relaxing to "bare DOCTYPE allowed" is still safe against the actual
 * parser in use (not just "should be" reasoning): xml.ts's parseXmlDocument
 * calls linkedom's `new DOMParser().parseFromString(xml, "text/xml")`.
 * linkedom is a pure-JS DOM implementation with no filesystem or network
 * module reachable from that call path — there is no `fetch`/`fs`/`http`
 * import anywhere between DOMParser and its XML tokenizer (verified by
 * reading node_modules/linkedom's parser source) — so it was ALREADY
 * incapable of resolving a SYSTEM/PUBLIC external identifier or fetching an
 * external entity, before or after this change. This function's checks are
 * defense-in-depth layered on top of that fact, not a substitute for it:
 * `<!ENTITY` (wherever it appears — standalone or inside a DOCTYPE's
 * internal subset) and any DOCTYPE naming an external subset or declaring an
 * internal one are still rejected unconditionally below, so nothing here
 * depends on linkedom continuing to lack that capability in some future
 * version — only the bare-DOCTYPE relaxation itself does, and a bare
 * DOCTYPE has no subset (internal or external) for any parser to act on
 * regardless of its capabilities.
 *
 * Deliberately NOT one regex over the whole document (spec §22's "CSS の
 * 安全化を正規表現 1 本だけで済ませない" caution applies equally to DTD
 * parsing): this locates every `<!DOCTYPE` occurrence first, rejects
 * outright on more than one (a well-formed XML document has at most one —
 * two or more is either malformed or an attempt to hide a dangerous second
 * declaration behind an innocuous first match), and only then asks whether
 * the SINGLE occurrence's own tail is *exactly* "whitespace, name, optional
 * whitespace, `>`" with nothing else — so `SYSTEM`/`PUBLIC` keywords, a `[`
 * internal-subset opener, an embedded comment, or any other unrecognized
 * shape all fall through to the reject at the bottom rather than needing
 * their own explicit pattern. `\s` (not `[ \t]`) so a DOCTYPE split across
 * multiple lines is still recognized as bare, and `/i` on every check
 * handles `<!doctype html>`.
 */
export function assertNoXxeMarkers(xml: string, code: EpubErrorCode): void {
  if (/<!ENTITY/i.test(xml)) {
    throw new EpubError(code, "ENTITY marker present");
  }

  const doctypeIndexes: number[] = [];
  const doctypeRe = /<!DOCTYPE/gi;
  let match: RegExpExecArray | null;
  while ((match = doctypeRe.exec(xml)) !== null) {
    doctypeIndexes.push(match.index);
  }
  if (doctypeIndexes.length === 0) {
    return;
  }
  if (doctypeIndexes.length > 1) {
    throw new EpubError(code, "multiple DOCTYPE markers present");
  }

  const tail = xml.slice(doctypeIndexes[0] as number);
  const isBareDoctype = /^<!DOCTYPE\s+[A-Za-z_][\w:.-]*\s*>/i.test(tail);
  if (!isBareDoctype) {
    throw new EpubError(code, "non-bare DOCTYPE present");
  }
}
