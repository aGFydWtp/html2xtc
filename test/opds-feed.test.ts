import { describe, expect, it } from "vitest";
import {
  OPDS_PAGE_SIZE,
  buildOpdsFeedXml,
  computeFeedUpdated,
  parsePage,
  trimPage,
} from "../src/opds/feed";
import type { OpdsFeedItem } from "../src/opds/feed";

const NOW = "2026-07-21T00:00:00.000Z";

describe("buildOpdsFeedXml", () => {
  it("builds an empty feed with no entries", () => {
    const xml = buildOpdsFeedXml({
      feedId: "urn:html2xtc:device:d1",
      title: "html2xtc マイライブラリ",
      updated: NOW,
      links: { self: "https://xtc.hr20k.com/opds/v1/catalog.xml" },
      items: [],
      downloadBaseUrl: "https://xtc.hr20k.com/api/device/library-items",
    });
    expect(xml).toContain("<id>urn:html2xtc:device:d1</id>");
    expect(xml).toContain(`<updated>${NOW}</updated>`);
    expect(xml).not.toContain("<entry>");
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
  });

  it("omits the <author> element entirely when author is null", () => {
    const items: OpdsFeedItem[] = [{ id: "item-1", title: "著者不明の本", author: null, updatedAt: NOW }];
    const xml = buildOpdsFeedXml({
      feedId: "urn:html2xtc:device:d1",
      title: "t",
      updated: NOW,
      links: { self: "https://xtc.hr20k.com/opds/v1/catalog.xml" },
      items,
      downloadBaseUrl: "https://xtc.hr20k.com/api/device/library-items",
    });
    expect(xml).not.toContain("<author>");
    expect(xml).toContain("<title>著者不明の本</title>");
  });

  it("includes <author><name> when author is present", () => {
    const items: OpdsFeedItem[] = [{ id: "item-1", title: "本", author: "著者名", updatedAt: NOW }];
    const xml = buildOpdsFeedXml({
      feedId: "urn:html2xtc:device:d1",
      title: "t",
      updated: NOW,
      links: { self: "https://xtc.hr20k.com/opds/v1/catalog.xml" },
      items,
      downloadBaseUrl: "https://xtc.hr20k.com/api/device/library-items",
    });
    expect(xml).toContain("<author><name>著者名</name></author>");
  });

  it("builds the acquisition link from downloadBaseUrl + itemId", () => {
    const items: OpdsFeedItem[] = [{ id: "item-1", title: "t", author: null, updatedAt: NOW }];
    const xml = buildOpdsFeedXml({
      feedId: "urn:html2xtc:device:d1",
      title: "t",
      updated: NOW,
      links: { self: "https://xtc.hr20k.com/opds/v1/catalog.xml" },
      items,
      downloadBaseUrl: "https://xtc.hr20k.com/api/device/library-items",
    });
    expect(xml).toContain(
      '<link rel="http://opds-spec.org/acquisition" href="https://xtc.hr20k.com/api/device/library-items/item-1/download" type="application/octet-stream"/>',
    );
  });

  it("escapes a Japanese title containing XML-special characters", () => {
    const items: OpdsFeedItem[] = [{ id: "item-1", title: `<猫> & "犬"`, author: null, updatedAt: NOW }];
    const xml = buildOpdsFeedXml({
      feedId: "urn:html2xtc:device:d1",
      title: "t",
      updated: NOW,
      links: { self: "https://xtc.hr20k.com/opds/v1/catalog.xml" },
      items,
      downloadBaseUrl: "https://xtc.hr20k.com/api/device/library-items",
    });
    expect(xml).toContain("<title>&lt;猫&gt; &amp; &quot;犬&quot;</title>");
  });

  it("includes search, next, and previous links only when provided", () => {
    const xml = buildOpdsFeedXml({
      feedId: "urn:html2xtc:device:d1",
      title: "t",
      updated: NOW,
      links: {
        self: "https://xtc.hr20k.com/opds/v1/catalog.xml?page=2",
        search: "https://xtc.hr20k.com/opds/v1/search.xml?q={searchTerms}",
        next: "https://xtc.hr20k.com/opds/v1/catalog.xml?page=3",
        previous: "https://xtc.hr20k.com/opds/v1/catalog.xml?page=1",
      },
      items: [],
      downloadBaseUrl: "https://xtc.hr20k.com/api/device/library-items",
    });
    expect(xml).toContain('rel="search"');
    expect(xml).toContain('rel="next"');
    expect(xml).toContain('rel="previous"');
  });
});

describe("computeFeedUpdated", () => {
  it("returns nowIso for an empty item list", () => {
    expect(computeFeedUpdated([], NOW)).toBe(NOW);
  });

  it("returns the max updatedAt across items", () => {
    const items = [
      { updatedAt: "2026-01-01T00:00:00.000Z" },
      { updatedAt: "2026-07-01T00:00:00.000Z" },
      { updatedAt: "2026-03-01T00:00:00.000Z" },
    ];
    expect(computeFeedUpdated(items, NOW)).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("parsePage", () => {
  it("defaults to 1 when absent", () => {
    expect(parsePage(null)).toBe(1);
  });

  it("accepts positive integers", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("42")).toBe(42);
  });

  it("rejects 0, negative, decimal, leading-zero, and non-numeric values", () => {
    for (const raw of ["0", "-1", "1.5", "01", "abc", ""]) {
      expect(parsePage(raw)).toBeNull();
    }
  });
});

describe("trimPage", () => {
  const rows = Array.from({ length: OPDS_PAGE_SIZE }, (_, i) => i);

  it("reports no next page when exactly pageSize rows come back", () => {
    const result = trimPage(rows, 1, OPDS_PAGE_SIZE);
    expect(result.pageItems).toHaveLength(OPDS_PAGE_SIZE);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrevious).toBe(false);
  });

  it("reports a next page and trims the extra row when pageSize + 1 come back", () => {
    const withExtra = [...rows, OPDS_PAGE_SIZE];
    const result = trimPage(withExtra, 1, OPDS_PAGE_SIZE);
    expect(result.pageItems).toHaveLength(OPDS_PAGE_SIZE);
    expect(result.pageItems).toEqual(rows);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrevious).toBe(false);
  });

  it("reports hasPrevious for any page beyond the first, regardless of row count", () => {
    expect(trimPage([], 2, OPDS_PAGE_SIZE).hasPrevious).toBe(true);
    expect(trimPage([], 1, OPDS_PAGE_SIZE).hasPrevious).toBe(false);
  });

  it("handles an empty result window (page past the end of the data)", () => {
    const result = trimPage([], 3, OPDS_PAGE_SIZE);
    expect(result.pageItems).toEqual([]);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrevious).toBe(true);
  });
});
