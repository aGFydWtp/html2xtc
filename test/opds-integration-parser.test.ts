// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { parseOpdsFeedXml } from "../src/integrations/opds/parser-v1";
import { ApiError } from "../src/security/errors";

const BASE_URL = "https://opds.example.com/secret/root";

const ROOT_FEED_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://opds.example.com/secret/root</id>
  <title>Test Catalog</title>
  <updated>2026-01-01T00:00:00Z</updated>
  <link rel="self" href="https://opds.example.com/secret/root" type="application/atom+xml"/>
  <link rel="search" href="/secret/opensearch.xml" type="application/opensearchdescription+xml"/>
  <link rel="next" href="/secret/root?page=2"/>
  <link rel="previous" href="/secret/root?page=0"/>
  <entry>
    <id>https://opds.example.com/secret/section1</id>
    <title>Recents</title>
    <updated>2026-01-01T00:00:00Z</updated>
    <link rel="subsection" href="/secret/section1" type="application/atom+xml;kind=acquisition"/>
  </entry>
  <entry>
    <id>urn:uuid:1111</id>
    <title>My Book</title>
    <author><name>Jane Doe</name></author>
    <updated>2026-01-02T00:00:00Z</updated>
    <link rel="http://opds-spec.org/acquisition" href="/secret/book1.epub" type="application/epub+zip"/>
    <link rel="alternate" href="/secret/book1.html" type="text/html"/>
  </entry>
  <entry>
    <id>urn:uuid:2222</id>
    <title>Octet Book</title>
    <link rel="http://opds-spec.org/acquisition" href="/secret/book2.epub?x=1" type="application/octet-stream"/>
  </entry>
  <entry>
    <id>urn:uuid:3333</id>
    <title>Not importable (wrong type)</title>
    <link rel="http://opds-spec.org/acquisition" href="/secret/book3" type="application/octet-stream"/>
  </entry>
</feed>`;

describe("parseOpdsFeedXml", () => {
  it("parses the feed title and entries", () => {
    const feed = parseOpdsFeedXml(ROOT_FEED_XML, BASE_URL);
    expect(feed.title).toBe("Test Catalog");
    expect(feed.entries).toHaveLength(4);
  });

  it("recognizes a rel=subsection link as a navigation entry with an absolute href", () => {
    const feed = parseOpdsFeedXml(ROOT_FEED_XML, BASE_URL);
    const nav = feed.entries[0];
    expect(nav?.kind).toBe("navigation");
    expect(nav?.navigationHref).toBe("https://opds.example.com/secret/section1");
  });

  it("recognizes an application/epub+zip acquisition link", () => {
    const feed = parseOpdsFeedXml(ROOT_FEED_XML, BASE_URL);
    const pub = feed.entries[1];
    expect(pub?.kind).toBe("publication");
    expect(pub?.acquisitionHref).toBe("https://opds.example.com/secret/book1.epub");
    expect(pub?.author).toBe("Jane Doe");
  });

  it("recognizes application/octet-stream + .epub href as an acquisition link", () => {
    const feed = parseOpdsFeedXml(ROOT_FEED_XML, BASE_URL);
    const pub = feed.entries[2];
    expect(pub?.kind).toBe("publication");
    expect(pub?.acquisitionHref).toBe("https://opds.example.com/secret/book2.epub?x=1");
  });

  it("does not recognize application/octet-stream without a .epub href", () => {
    const feed = parseOpdsFeedXml(ROOT_FEED_XML, BASE_URL);
    const pub = feed.entries[3];
    expect(pub?.kind).toBe("publication");
    expect(pub?.acquisitionHref).toBeUndefined();
  });

  it("has no author when the entry omits one", () => {
    const feed = parseOpdsFeedXml(ROOT_FEED_XML, BASE_URL);
    expect(feed.entries[0]?.author).toBeNull();
  });

  it("parses next/previous/search feed-level links as absolute URLs", () => {
    const feed = parseOpdsFeedXml(ROOT_FEED_XML, BASE_URL);
    expect(feed.nextHref).toBe("https://opds.example.com/secret/root?page=2");
    expect(feed.previousHref).toBe("https://opds.example.com/secret/root?page=0");
    expect(feed.searchHref).toBe("https://opds.example.com/secret/opensearch.xml");
  });

  it("has null next/previous/search when the feed has none (Memlane's actual feeds omit paging — spec §A)", () => {
    const minimal = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>`;
    const feed = parseOpdsFeedXml(minimal, BASE_URL);
    expect(feed.nextHref).toBeNull();
    expect(feed.previousHref).toBeNull();
    expect(feed.searchHref).toBeNull();
    expect(feed.entries).toHaveLength(0);
  });

  it("throws OPDS_FEED_INVALID on empty/unparseable content", () => {
    // linkedom's DOMParser is lenient about malformed tag soup (matching
    // src/epub/xml.ts's own documented behavior — it never throws, only
    // returns documentElement: null for genuinely unparseable input), so
    // this exercises the one shape that reliably produces a null root.
    expect(() => parseOpdsFeedXml("", BASE_URL)).toThrow(ApiError);
  });

  it("throws OPDS_FEED_INVALID on a document that isn't a <feed>", () => {
    expect(() => parseOpdsFeedXml("<html><body>not opds</body></html>", BASE_URL)).toThrow(ApiError);
  });

  it("throws OPDS_FEED_INVALID on a DOCTYPE with an external subset (XXE shape)", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE feed SYSTEM "http://evil.example.com/x.dtd"><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>`;
    expect(() => parseOpdsFeedXml(xxe, BASE_URL)).toThrow(ApiError);
  });

  it("throws OPDS_FEED_INVALID on an <!ENTITY declaration", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY x "y">]><feed xmlns="http://www.w3.org/2005/Atom"><title>&x;</title></feed>`;
    expect(() => parseOpdsFeedXml(xxe, BASE_URL)).toThrow(ApiError);
  });

  it("allows a bare DOCTYPE with no subset", () => {
    const bare = `<?xml version="1.0"?><!DOCTYPE feed><feed xmlns="http://www.w3.org/2005/Atom"><title>ok</title></feed>`;
    expect(() => parseOpdsFeedXml(bare, BASE_URL)).not.toThrow();
  });

  it("throws OPDS_FEED_INVALID when the feed exceeds the max size", () => {
    const huge = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${"x".repeat(2_000_000)}</title></feed>`;
    expect(() => parseOpdsFeedXml(huge, BASE_URL)).toThrow(ApiError);
  });

  it("deduplicates entries that share the same <id>, keeping the first occurrence", () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Dup</title>
      <entry><id>urn:uuid:dup</id><title>First</title></entry>
      <entry><id>urn:uuid:dup</id><title>Second</title></entry>
      <entry><id>urn:uuid:other</id><title>Third</title></entry>
    </feed>`;
    const feed = parseOpdsFeedXml(xml, BASE_URL);
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries.map((e) => e.title)).toEqual(["First", "Third"]);
  });

  it("throws OPDS_FEED_INVALID when the feed has more than 100 entries", () => {
    const entries = Array.from(
      { length: 101 },
      (_, i) => `<entry><id>urn:uuid:${i}</id><title>Book ${i}</title></entry>`,
    ).join("");
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Many</title>${entries}</feed>`;
    expect(() => parseOpdsFeedXml(xml, BASE_URL)).toThrow(ApiError);
  });
});
