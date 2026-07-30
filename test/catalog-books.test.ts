// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import {
  BOOK_SEARCH_SQL,
  clampBookSearchLimit,
  DEFAULT_BOOK_SEARCH_LIMIT,
  MAX_BOOK_SEARCH_LIMIT,
  mapBookRow,
  normalizeBookSearchQuery,
  parseBookSearchPage,
  searchBooks,
  trimBookSearchPage,
} from "../src/catalog-db";

describe("mapBookRow", () => {
  // (1) snake_case -> camelCase, contributor_names -> author verbatim,
  // copyrighted integer 1 -> true.
  it("maps a copyrighted row with all fields present", () => {
    expect(
      mapBookRow({
        work_id: "000773",
        title: "こころ",
        subtitle: "後篇",
        contributor_names: "夏目 漱石",
        copyrighted: 1,
        html_url: "https://example.com/773.html",
        card_url: "https://example.com/card/773",
      }),
    ).toEqual({
      workId: "000773",
      title: "こころ",
      subtitle: "後篇",
      author: "夏目 漱石",
      htmlUrl: "https://example.com/773.html",
      cardUrl: "https://example.com/card/773",
      copyrighted: true,
    });
  });

  // (2) copyrighted 0 -> false, null subtitle stays null, empty
  // contributor_names stays "".
  it("maps a public-domain row with null subtitle and empty author", () => {
    const result = mapBookRow({
      work_id: "000148",
      title: "吾輩は猫である",
      subtitle: null,
      contributor_names: "",
      copyrighted: 0,
      html_url: "https://example.com/148.html",
      card_url: "https://example.com/card/148",
    });
    expect(result.subtitle).toBeNull();
    expect(result.author).toBe("");
    expect(result.copyrighted).toBe(false);
  });

  // (3) Only copyrighted === 1 is true; any other integer is false.
  it("treats only integer 1 as copyrighted", () => {
    const base = {
      work_id: "x",
      title: "t",
      subtitle: null,
      contributor_names: "a",
      html_url: "h",
      card_url: "c",
    };
    expect(mapBookRow({ ...base, copyrighted: 0 }).copyrighted).toBe(false);
    expect(mapBookRow({ ...base, copyrighted: 1 }).copyrighted).toBe(true);
    expect(mapBookRow({ ...base, copyrighted: 2 }).copyrighted).toBe(false);
  });
});

describe("clampBookSearchLimit", () => {
  // (4) Absent / blank falls back to the default.
  it("defaults when the param is null or blank", () => {
    expect(clampBookSearchLimit(null)).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("   ")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
  });

  // (5) Valid values in range pass through; the bottom of the range is 1.
  it("passes valid in-range integers through", () => {
    expect(clampBookSearchLimit("1")).toBe(1);
    expect(clampBookSearchLimit("25")).toBe(25);
    expect(clampBookSearchLimit(String(MAX_BOOK_SEARCH_LIMIT))).toBe(
      MAX_BOOK_SEARCH_LIMIT,
    );
  });

  // (6) Above the cap clamps down; non-integers / < 1 fall back to default.
  it("clamps above the cap and rejects invalid values", () => {
    expect(clampBookSearchLimit(String(MAX_BOOK_SEARCH_LIMIT))).toBe(MAX_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit(String(MAX_BOOK_SEARCH_LIMIT + 1))).toBe(MAX_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("1000")).toBe(MAX_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("0")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("-3")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("2.5")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("abc")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
  });

  // (6b) The default and the cap are no longer the same value -- DEFAULT_BOOK_SEARCH_LIMIT=50 is a
  // sensible page size, MAX_BOOK_SEARCH_LIMIT=100 is the ceiling a caller can opt into via ?limit=.
  it("keeps the default strictly below the cap", () => {
    expect(DEFAULT_BOOK_SEARCH_LIMIT).toBeLessThan(MAX_BOOK_SEARCH_LIMIT);
    expect(DEFAULT_BOOK_SEARCH_LIMIT).toBe(50);
    expect(MAX_BOOK_SEARCH_LIMIT).toBe(100);
  });
});

describe("parseBookSearchPage", () => {
  // (6c) Absent means page 1.
  it("defaults to 1 when the param is absent", () => {
    expect(parseBookSearchPage(null)).toBe(1);
  });

  // (6d) Plain positive integers pass through.
  it("passes plain positive integers through", () => {
    expect(parseBookSearchPage("1")).toBe(1);
    expect(parseBookSearchPage("2")).toBe(2);
    expect(parseBookSearchPage("1000")).toBe(1000);
  });

  // (6e) Zero, negative, non-integer, non-numeric, and leading-zero/sign
  // forms are all rejected as null so the route can 400 rather than coerce.
  it("rejects zero, negative, decimal, and non-numeric values", () => {
    expect(parseBookSearchPage("0")).toBeNull();
    expect(parseBookSearchPage("-1")).toBeNull();
    expect(parseBookSearchPage("1.5")).toBeNull();
    expect(parseBookSearchPage("abc")).toBeNull();
    expect(parseBookSearchPage("")).toBeNull();
    expect(parseBookSearchPage("01")).toBeNull();
    expect(parseBookSearchPage("+1")).toBeNull();
  });
});

describe("trimBookSearchPage", () => {
  // (6f) Exactly `limit` rows: no next page, nothing trimmed.
  it("reports no next page when the window fills exactly to limit", () => {
    expect(trimBookSearchPage([1, 2, 3], 3)).toEqual({ books: [1, 2, 3], hasNext: false });
  });

  // (6g) Fewer than `limit` rows: no next page either.
  it("reports no next page when the window has fewer rows than limit", () => {
    expect(trimBookSearchPage([1, 2], 3)).toEqual({ books: [1, 2], hasNext: false });
  });

  // (6h) `limit + 1` rows: trims the extra row and reports a next page.
  it("trims the extra row and reports a next page when the window overflows limit", () => {
    expect(trimBookSearchPage([1, 2, 3, 4], 3)).toEqual({ books: [1, 2, 3], hasNext: true });
  });

  // (6i) An empty window is not a next page.
  it("reports no next page for an empty window", () => {
    expect(trimBookSearchPage([], 3)).toEqual({ books: [], hasNext: false });
  });
});

describe("normalizeBookSearchQuery", () => {
  // (7) Missing / blank / punctuation-only reduces to "" (the handler's
  // empty-result guard, no D1 hit).
  it("returns empty string for missing or unsearchable queries", () => {
    expect(normalizeBookSearchQuery(null)).toBe("");
    expect(normalizeBookSearchQuery("")).toBe("");
    expect(normalizeBookSearchQuery("   ")).toBe("");
    expect(normalizeBookSearchQuery("、。・！？")).toBe("");
  });

  // (8) Katakana -> hiragana, NFKC + lowercase, matching the indexed columns.
  it("normalizes like the indexed search_text column", () => {
    expect(normalizeBookSearchQuery("ココロ")).toBe("こころ");
    expect(normalizeBookSearchQuery("ＡＢＣ")).toBe("abc");
    expect(normalizeBookSearchQuery(" 夏目 漱石 ")).toBe("夏目漱石");
  });

  // (9) Regression: LIKE metacharacters are stripped by normalization, so the
  // value concatenated into the '%' || ?1 || '%' pattern can never inject a
  // wildcard (no ESCAPE needed).
  it("strips LIKE wildcards % and _", () => {
    expect(normalizeBookSearchQuery("100%")).toBe("100");
    expect(normalizeBookSearchQuery("a_b")).toBe("ab");
    expect(normalizeBookSearchQuery("%_%")).toBe("");
  });
});

/**
 * Minimal D1 stub: records the SQL prepared and the params bound, and returns
 * a fixed result set. Enough to assert searchBooks binds [query, limit,
 * offset] and maps rows through mapBookRow.
 */
function stubDb(rows: unknown[]): {
  db: D1Database;
  calls: { sql: string; params: unknown[] };
} {
  const calls = { sql: "", params: [] as unknown[] };
  const db = {
    prepare(sql: string) {
      calls.sql = sql;
      return {
        bind(...params: unknown[]) {
          calls.params = params;
          return {
            async all() {
              return { results: rows };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("searchBooks", () => {
  // (10) Binds exactly [normalizedQuery, limit, offset] in order, against the
  // shared BOOK_SEARCH_SQL over the active view.
  it("binds the query, limit, and offset and uses BOOK_SEARCH_SQL", async () => {
    const { db, calls } = stubDb([]);
    await searchBooks(db, "こころ", { limit: 26, offset: 25 });
    expect(calls.sql).toBe(BOOK_SEARCH_SQL);
    expect(calls.sql).toContain("FROM aozora_books_active");
    expect(calls.sql).toContain("ORDER BY");
    expect(calls.sql).toContain("LIMIT ?2 OFFSET ?3");
    expect(calls.params).toEqual(["こころ", 26, 25]);
  });

  // (10b) The ORDER BY clause ends on work_id, the tiebreak that keeps
  // OFFSET-paged results stable across pages when rows tie on every other
  // sort key.
  it("tiebreaks the ORDER BY on work_id", () => {
    expect(BOOK_SEARCH_SQL).toMatch(/title_normalized,\s*work_id\s*LIMIT/);
  });

  // (11) Maps every returned row through mapBookRow.
  it("maps result rows to the camelCased response shape", async () => {
    const { db } = stubDb([
      {
        work_id: "000773",
        title: "こころ",
        subtitle: null,
        contributor_names: "夏目 漱石",
        copyrighted: 0,
        html_url: "https://example.com/773.html",
        card_url: "https://example.com/card/773",
      },
    ]);
    const hits = await searchBooks(db, "こころ", { limit: 51, offset: 0 });
    expect(hits).toEqual([
      {
        workId: "000773",
        title: "こころ",
        subtitle: null,
        author: "夏目 漱石",
        htmlUrl: "https://example.com/773.html",
        cardUrl: "https://example.com/card/773",
        copyrighted: false,
      },
    ]);
  });
});
