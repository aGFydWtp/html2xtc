// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Provider-agnostic XXE defense-in-depth for any XML text about to be fed to
 * linkedom's `DOMParser` (src/epub/xml.ts's parseXmlDocument, and this
 * repo's second XML consumer, src/integrations/opds/parser-v1.ts). Extracted
 * out of src/epub/errors.ts's original EpubErrorCode-typed
 * `assertNoXxeMarkers` so both the EPUB parser and the OPDS parser share one
 * detection implementation instead of two independently-maintained regexes
 * (OPDS spec §16 / implementation notes: "EpubErrorCode に依存しない汎用版を
 * 切り出して OPDS parser でも使う").
 *
 * This module only returns a reason string (or null) — it never throws and
 * carries no error-code type of its own, so each caller wraps the result in
 * whatever error type is appropriate for its own domain (EpubError here,
 * OpdsError in the OPDS parser).
 *
 * Full XXE-surface rationale (verified against linkedom's actual parser
 * source — a pure-JS DOM implementation with no filesystem/network module
 * reachable from DOMParser, so it was already incapable of resolving a
 * SYSTEM/PUBLIC external identifier before this check existed): the real
 * attack surface is (a) an ENTITY declaration (billion-laughs, or an
 * external entity used to exfiltrate/fetch something) and (b) a DOCTYPE
 * that itself names an external subset or declares an internal one. A bare
 * `<!DOCTYPE name>` — no external identifier, no internal subset — carries
 * neither risk, so it is deliberately allowed (real-world repro that forced
 * this narrowing: a 青空文庫-toolchain EPUB whose XHTML files open with a
 * plain `<!DOCTYPE html>`, see src/epub/errors.ts's original 2026-07-26
 * history for the full incident writeup preserved there).
 *
 * Deliberately not one regex over the whole document: this locates every
 * `<!DOCTYPE` occurrence first, rejects outright on more than one occurrence
 * (a well-formed XML document has at most one), and only then asks whether
 * the single occurrence's own tail is *exactly* "whitespace, name, optional
 * whitespace, `>`" with nothing else — so `SYSTEM`/`PUBLIC`, an internal-
 * subset `[`, an embedded comment, or any other unrecognized shape all fall
 * through to the reject at the bottom rather than needing their own
 * explicit pattern.
 */
export function detectXxeMarker(xml: string): string | null {
  if (/<!ENTITY/i.test(xml)) {
    return "ENTITY marker present";
  }

  const doctypeIndexes: number[] = [];
  const doctypeRe = /<!DOCTYPE/gi;
  let match: RegExpExecArray | null;
  while ((match = doctypeRe.exec(xml)) !== null) {
    doctypeIndexes.push(match.index);
  }
  if (doctypeIndexes.length === 0) {
    return null;
  }
  if (doctypeIndexes.length > 1) {
    return "multiple DOCTYPE markers present";
  }

  const tail = xml.slice(doctypeIndexes[0] as number);
  const isBareDoctype = /^<!DOCTYPE\s+[A-Za-z_][\w:.-]*\s*>/i.test(tail);
  return isBareDoctype ? null : "non-bare DOCTYPE present";
}
