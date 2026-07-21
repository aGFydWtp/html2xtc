// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Pure XML-safety helpers for the OPDS Atom feed (plan §10.1 "XML特殊文字を
 * 必ずエスケープする" / "タイトルや著者に制御文字を許可しない"). Kept free of
 * cloudflare:* imports so both are directly unit-testable under plain vitest
 * (see test/opds-xml.test.ts), same rationale as src/ratelimit.ts.
 *
 * Every piece of untrusted text placed into the feed XML built by
 * src/opds/feed.ts (item titles, author names, source-derived strings) MUST
 * go through escapeXmlText — never interpolated raw into a template string.
 */

/**
 * Matches C0 control characters illegal in XML 1.0 text content (tab
 * U+0009, LF U+000A, and CR U+000D are explicitly legal and excluded here)
 * plus DEL (U+007F). Built via the RegExp constructor from an escaped
 * string, rather than a literal control character in source, so the source
 * file itself stays free of raw control bytes.
 */
const ILLEGAL_XML_CONTROL_CHARS = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]", "g");

/**
 * Strips characters illegal in XML 1.0 text content. Titles/authors are
 * already control-char-sanitized on write by src/library/service.ts's
 * sanitizeText, but this is the last line of defense at the point untrusted
 * text is serialized into hand-built XML, and covers any row saved before
 * that sanitization existed.
 */
export function stripControlChars(value: string): string {
  return value.replace(ILLEGAL_XML_CONTROL_CHARS, "");
}

/**
 * Escapes the five XML predefined entities (order matters: & first, so the
 * entities' own literal "&" is not re-escaped) after stripping control
 * characters. Safe for both XML text content and (single- or double-quoted)
 * attribute values.
 */
export function escapeXmlText(value: string): string {
  return stripControlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
