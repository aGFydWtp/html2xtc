// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { elementsByLocalName, parseXmlDocument } from "../../epub/xml";
import { Errors } from "../../security/errors";
import { detectXxeMarker } from "../../xml-safety";

/**
 * OpenSearch description document parsing (spec §5.1's "OpenSearch search
 * templateがある場合の検索" + the Memlane investigation, §7: a feed's
 * rel="search" link points at an OpenSearch *description document*, not
 * directly at a templated search URL — the actual `<Url
 * template="...{searchTerms}...">` lives inside that separate document,
 * which this module fetches-then-parses).
 */

const MAX_OPENSEARCH_XML_BYTES = 65_536; // description documents are tiny; generous but bounded

/**
 * Extracts the Atom-results search URL template from an OpenSearch
 * description document, resolved to an absolute URL against `baseUrl`.
 * Prefers a `<Url>` entry whose `type` mentions "atom" (OPDS search results
 * are Atom feeds); falls back to the first `<Url template="...">` found.
 * Returns null when the document has no usable template — never throws for
 * "no search available", only for a malformed/oversized/XXE-shaped document.
 */
export function parseOpenSearchTemplate(xml: string, baseUrl: string): string | null {
  if (new TextEncoder().encode(xml).length > MAX_OPENSEARCH_XML_BYTES) {
    throw Errors.unprocessable("OPDS_FEED_INVALID", "OpenSearch description exceeds the maximum allowed size");
  }
  if (detectXxeMarker(xml) !== null) {
    throw Errors.unprocessable("OPDS_FEED_INVALID", "OpenSearch description contains a disallowed XML construct");
  }

  const doc = parseXmlDocument(xml);
  const root = doc.documentElement;
  if (root === null) {
    return null;
  }

  const urlEls = elementsByLocalName(root, "url").filter((el) => el.getAttribute("template") !== null);
  const preferred =
    urlEls.find((el) => (el.getAttribute("type") ?? "").toLowerCase().includes("atom")) ?? urlEls[0];
  const template = preferred?.getAttribute("template") ?? null;
  if (template === null) {
    return null;
  }
  try {
    return new URL(template, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Substitutes `{searchTerms}` in a resolved OpenSearch template with the percent-encoded query. Returns null if the template has no such placeholder. */
export function buildOpdsSearchUrl(template: string, query: string): string | null {
  if (!template.includes("{searchTerms}")) {
    return null;
  }
  return template.replace("{searchTerms}", encodeURIComponent(query));
}
