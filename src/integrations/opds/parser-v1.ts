// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import {
  elementsByLocalName,
  firstByLocalName,
  localName,
  parseXmlDocument,
} from "../../epub/xml";
import type { XmlElement } from "../../epub/xml";
import { Errors } from "../../security/errors";
import { detectXxeMarker } from "../../xml-safety";
import type { ParsedOpdsEntry, ParsedOpdsFeed, ParsedOpdsLink } from "./types";

/**
 * OPDS 1.x / Atom feed parser (spec §16). Reuses src/epub/xml.ts's linkedom
 * plumbing (parseXmlDocument/elementsByLocalName/firstByLocalName/
 * localName) rather than a second XML library — this codebase already has
 * exactly one battle-tested XML parser (proven against real-world EPUB
 * feeds), and OPDS is Atom, the same family of XML the EPUB nav/OPF parsers
 * already handle. Namespace-agnostic by design (localName strips any
 * "atom:"/"opds:" prefix), matching how Memlane's actual feed (investigated
 * under spec §7) uses the bare Atom default namespace throughout.
 *
 * OPDS 2.0 (JSON) is explicitly out of scope (spec §4/§28) — this module
 * only ever sees Atom XML text.
 */

const MAX_FEED_XML_BYTES = 1_048_576; // spec §16 "XML最大1 MiB"
const MAX_FEED_ENTRIES = 100; // spec §16 "entry最大100"
const MAX_STRING_CHARS = 500; // spec §16 "各文字列長上限" — display strings only, not a security boundary; truncated rather than rejected.

const NAVIGATION_RELS: ReadonlySet<string> = new Set([
  // Memlane's actual feed (spec §7 investigation) uses the bare "subsection"
  // token; the OPDS 1.x spec's own registered rel is the fully-qualified
  // URI. Both are accepted so a stricter-to-the-letter server keeps working.
  "subsection",
  "http://opds-spec.org/subsection",
]);

const ACQUISITION_REL_PREFIX = "http://opds-spec.org/acquisition";

function truncate(value: string): string {
  return Array.from(value).slice(0, MAX_STRING_CHARS).join("");
}

function resolveHref(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseLinks(entryOrFeed: XmlElement, baseUrl: string): ParsedOpdsLink[] {
  const links: ParsedOpdsLink[] = [];
  for (const el of elementsByLocalName(entryOrFeed, "link")) {
    const href = el.getAttribute("href");
    if (href === null) {
      continue;
    }
    const resolved = resolveHref(href, baseUrl);
    if (resolved === null) {
      continue;
    }
    links.push({
      rel: el.getAttribute("rel") ?? "",
      type: el.getAttribute("type"),
      href: resolved,
    });
  }
  return links;
}

function isEpubAcquisitionLink(link: ParsedOpdsLink): boolean {
  if (link.rel !== ACQUISITION_REL_PREFIX && !link.rel.startsWith(`${ACQUISITION_REL_PREFIX}/`)) {
    return false;
  }
  if (link.type === "application/epub+zip") {
    return true;
  }
  // spec §16 EPUB判定 #2: application/octet-stream かつ href末尾 .epub
  if (link.type === "application/octet-stream" && /\.epub(?:[?#]|$)/i.test(link.href)) {
    return true;
  }
  return false;
}

function isNavigationLink(link: ParsedOpdsLink): boolean {
  return NAVIGATION_RELS.has(link.rel);
}

function findLinkByRel(links: ParsedOpdsLink[], rel: string): ParsedOpdsLink | undefined {
  return links.find((link) => link.rel === rel);
}

function parseEntry(entryEl: XmlElement, baseUrl: string): ParsedOpdsEntry | null {
  const idEl = firstByLocalName(entryEl, "id");
  const titleEl = firstByLocalName(entryEl, "title");
  const updatedEl = firstByLocalName(entryEl, "updated");
  const authorEl = firstByLocalName(entryEl, "author");
  const authorNameEl = authorEl !== undefined ? firstByLocalName(authorEl, "name") : undefined;

  const sourceId = truncate((idEl?.textContent ?? "").trim());
  const title = truncate((titleEl?.textContent ?? "").trim());
  if (sourceId.length === 0 || title.length === 0) {
    return null; // an entry with neither an id nor a title carries nothing usable
  }
  const author = authorNameEl?.textContent?.trim();
  const updated = updatedEl?.textContent?.trim();

  const links = parseLinks(entryEl, baseUrl);
  const navigationLink = links.find(isNavigationLink);
  if (navigationLink !== undefined) {
    return {
      kind: "navigation",
      sourceId,
      title,
      author: author !== undefined && author.length > 0 ? truncate(author) : null,
      updated: updated !== undefined && updated.length > 0 ? updated : null,
      navigationHref: navigationLink.href,
    };
  }

  const acquisitionLink = links.find(isEpubAcquisitionLink);
  return {
    kind: "publication",
    sourceId,
    title,
    author: author !== undefined && author.length > 0 ? truncate(author) : null,
    updated: updated !== undefined && updated.length > 0 ? updated : null,
    ...(acquisitionLink !== undefined ? { acquisitionHref: acquisitionLink.href } : {}),
  };
}

/**
 * Parses `xml` (the raw response body of an OPDS feed fetched from
 * `baseUrl`) into a ParsedOpdsFeed. Throws Errors.unprocessable
 * ("OPDS_FEED_INVALID") on anything malformed, oversized, XXE-shaped, or
 * simply not an Atom feed — never a partial/best-effort result, so a caller
 * never silently proceeds on a feed it didn't fully understand.
 */
export function parseOpdsFeedXml(xml: string, baseUrl: string): ParsedOpdsFeed {
  if (new TextEncoder().encode(xml).length > MAX_FEED_XML_BYTES) {
    throw Errors.unprocessable("OPDS_FEED_INVALID", "feed exceeds the maximum allowed size");
  }
  const xxeReason = detectXxeMarker(xml);
  if (xxeReason !== null) {
    throw Errors.unprocessable("OPDS_FEED_INVALID", "feed contains a disallowed XML construct");
  }

  const doc = parseXmlDocument(xml);
  const root = doc.documentElement;
  if (root === null || localName(root.tagName) !== "feed") {
    throw Errors.unprocessable("OPDS_FEED_INVALID", "not a valid OPDS/Atom feed");
  }

  const titleEl = firstByLocalName(root, "title");
  const title = truncate((titleEl?.textContent ?? "").trim());

  const feedLinks = parseLinks(root, baseUrl);
  const nextHref = findLinkByRel(feedLinks, "next")?.href ?? null;
  const previousHref = findLinkByRel(feedLinks, "previous")?.href ?? null;
  const searchHref = findLinkByRel(feedLinks, "search")?.href ?? null;

  const entryEls = elementsByLocalName(root, "entry");
  if (entryEls.length > MAX_FEED_ENTRIES) {
    throw Errors.unprocessable("OPDS_FEED_INVALID", "feed contains too many entries");
  }

  // Deduplicated by sourceId: two entries sharing the same <id> would opaque-
  // ify (opaqueOpdsEntryId, keyed by connectionId+sourceId) to the same
  // client-facing id, and the frontend uses that id as a Svelte {#each} key —
  // a duplicate there is a hard client-side error, not just a cosmetic glitch.
  // First occurrence wins; this can happen from a simply-buggy feed, not only
  // a malicious one, so it's silently deduplicated rather than rejected.
  const seenSourceIds = new Set<string>();
  const entries: ParsedOpdsEntry[] = [];
  for (const entryEl of entryEls) {
    const entry = parseEntry(entryEl, baseUrl);
    if (entry === null || seenSourceIds.has(entry.sourceId)) {
      continue;
    }
    seenSourceIds.add(entry.sourceId);
    entries.push(entry);
  }

  return { title, entries, nextHref, previousHref, searchHref };
}
