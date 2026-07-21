// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { escapeXmlText } from "./xml";

/**
 * Pure OPDS 1.x (Atom) feed builder + pagination math (plan §10.1/§10.2).
 * Kept free of cloudflare:* / D1 imports so both the XML assembly and the
 * pagination boundary logic stay directly unit-testable under plain vitest
 * (see test/opds-feed.test.ts) — src/opds/repository.ts is the only module
 * in this package that touches D1.
 */

/** Items per OPDS page (plan §10.2 "100件/ページ"). */
export const OPDS_PAGE_SIZE = 100;

export interface OpdsFeedItem {
  id: string;
  title: string;
  author: string | null;
  updatedAt: string;
}

export interface OpdsFeedLinks {
  self: string;
  /** Only present on the root catalog feed, not on search results (plan §10.1). */
  search?: string;
  next?: string;
  previous?: string;
}

export interface BuildOpdsFeedParams {
  /** e.g. "urn:html2xtc:device:{deviceId}" (plan §10.1). */
  feedId: string;
  title: string;
  /** ISO-8601 UTC timestamp — the feed's <updated> (see computeFeedUpdated). */
  updated: string;
  links: OpdsFeedLinks;
  /** Already the current page's slice, in the order they should render. */
  items: OpdsFeedItem[];
  /** e.g. "https://xtc.hr20k.com/api/device/library-items" — item id + "/download" is appended per entry. */
  downloadBaseUrl: string;
}

/**
 * Builds the full OPDS 1.x Atom XML document for either the root catalog
 * feed or a search-results feed — the two share every element except which
 * links are present (plan §10.1's example feed shape, applied verbatim).
 * Every piece of untrusted text (titles, author names) is escaped via
 * escapeXmlText; nothing is ever interpolated raw.
 */
export function buildOpdsFeedXml(params: BuildOpdsFeedParams): string {
  const linkLines = buildLinkLines(params.links);
  const entryLines = params.items.map((item) => buildEntryXml(item, params.downloadBaseUrl));

  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">',
    `  <id>${escapeXmlText(params.feedId)}</id>`,
    `  <title>${escapeXmlText(params.title)}</title>`,
    `  <updated>${escapeXmlText(params.updated)}</updated>`,
    ...linkLines,
    ...entryLines,
    "</feed>",
  ];
  return lines.join("\n") + "\n";
}

function buildLinkLines(links: OpdsFeedLinks): string[] {
  const lines = [
    `  <link rel="self" href="${escapeXmlText(links.self)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
  ];
  if (links.search !== undefined) {
    lines.push(`  <link rel="search" href="${escapeXmlText(links.search)}" type="application/atom+xml"/>`);
  }
  if (links.next !== undefined) {
    lines.push(
      `  <link rel="next" href="${escapeXmlText(links.next)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
    );
  }
  if (links.previous !== undefined) {
    lines.push(
      `  <link rel="previous" href="${escapeXmlText(links.previous)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
    );
  }
  return lines;
}

function buildEntryXml(item: OpdsFeedItem, downloadBaseUrl: string): string {
  const authorLine =
    item.author !== null && item.author.length > 0
      ? `\n    <author><name>${escapeXmlText(item.author)}</name></author>`
      : "";
  const href = `${downloadBaseUrl}/${encodeURIComponent(item.id)}/download`;
  return [
    "  <entry>",
    `    <id>urn:html2xtc:item:${escapeXmlText(item.id)}</id>`,
    `    <title>${escapeXmlText(item.title)}</title>${authorLine}`,
    `    <updated>${escapeXmlText(item.updatedAt)}</updated>`,
    `    <link rel="http://opds-spec.org/acquisition" href="${escapeXmlText(href)}" type="application/octet-stream"/>`,
    "  </entry>",
  ].join("\n");
}

/**
 * The feed's <updated>: the max of the page's items' updatedAt (plan says
 * "item の updated_at 最大値"), or nowIso when there are no items. ISO-8601
 * strings produced by `new Date().toISOString()` are fixed-width and always
 * UTC ("Z"-suffixed), so plain lexicographic comparison sorts them
 * chronologically — same assumption src/catalog-db.ts's lock-expiry checks
 * already rely on.
 */
export function computeFeedUpdated(items: ReadonlyArray<{ updatedAt: string }>, nowIso: string): string {
  if (items.length === 0) {
    return nowIso;
  }
  let max = items[0]!.updatedAt;
  for (const item of items) {
    if (item.updatedAt > max) {
      max = item.updatedAt;
    }
  }
  return max;
}

/**
 * Parses the `?page=` query param (plan §10.2 "1始まり"): missing means page
 * 1; anything that isn't a plain positive integer (no leading zero, no
 * sign, no decimal) is rejected as null so the route can 400 rather than
 * silently coerce "abc" or "-1" to some page. Deliberately doesn't clamp to
 * an upper bound — trimPage below already degrades gracefully to an empty
 * page far past the end of the data.
 */
export function parsePage(raw: string | null): number | null {
  if (raw === null) {
    return 1;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export interface PageWindow<T> {
  pageItems: T[];
  hasNext: boolean;
  hasPrevious: boolean;
}

/**
 * Trims a `pageSize + 1`-row fetch window down to the page's items plus
 * hasNext/hasPrevious — pure, so the pagination boundary math (plan §18.1
 * "ページング境界": exactly pageSize rows, pageSize+1 rows, page 1 vs page
 * N>1) is unit-testable without D1. The caller (src/opds/repository.ts) is
 * expected to fetch exactly `pageSize + 1` rows starting at
 * `(page - 1) * pageSize`; fetching one extra row is how "is there a next
 * page" is answered without a separate COUNT(*) query.
 */
export function trimPage<T>(rows: T[], page: number, pageSize: number = OPDS_PAGE_SIZE): PageWindow<T> {
  const hasNext = rows.length > pageSize;
  return {
    pageItems: hasNext ? rows.slice(0, pageSize) : rows,
    hasNext,
    hasPrevious: page > 1,
  };
}
