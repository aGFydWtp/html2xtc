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
  searchBooks,
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
    expect(clampBookSearchLimit("51")).toBe(MAX_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("1000")).toBe(MAX_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("0")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("-3")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("2.5")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
    expect(clampBookSearchLimit("abc")).toBe(DEFAULT_BOOK_SEARCH_LIMIT);
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
 * a fixed result set. Enough to assert searchBooks binds [query, limit] and
 * maps rows through mapBookRow.
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
  // (10) Binds exactly [normalizedQuery, limit] in order, against the shared
  // BOOK_SEARCH_SQL over the active view.
  it("binds the query then the limit and uses BOOK_SEARCH_SQL", async () => {
    const { db, calls } = stubDb([]);
    await searchBooks(db, "こころ", 25);
    expect(calls.sql).toBe(BOOK_SEARCH_SQL);
    expect(calls.sql).toContain("FROM aozora_books_active");
    expect(calls.params).toEqual(["こころ", 25]);
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
    const hits = await searchBooks(db, "こころ", 50);
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
