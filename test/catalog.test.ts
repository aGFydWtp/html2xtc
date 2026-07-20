import { readFileSync } from "node:fs";
import * as Papa from "papaparse";
import { describe, expect, it } from "vitest";
import {
  aggregateCatalog,
  buildGeneration,
  CatalogValidationError,
  chunk,
  normalizeCatalogText,
  nullIfEmpty,
  parseCopyrightFlag,
  stripBom,
  validateCatalogHeaders,
  REQUIRED_HEADERS,
} from "../src/catalog";
import type { AozoraBookRow, CatalogCsvRecord } from "../src/catalog";

const GENERATION = "20260720T183000Z-abcdef012345";

// vitest runs with the project root as cwd, so this relative path is stable.
const FIXTURE_PATH = "test/fixtures/aozora-catalog-small.csv";

/** Parses the shared fixture the way the Workflow's parse step does. */
function parseFixture(text: string): CatalogCsvRecord[] {
  const parsed = Papa.parse<CatalogCsvRecord>(stripBom(text), {
    header: true,
    skipEmptyLines: "greedy",
  });
  return parsed.data;
}

function loadFixtureRecords(): CatalogCsvRecord[] {
  return parseFixture(readFileSync(FIXTURE_PATH, "utf8"));
}

function bookById(books: AozoraBookRow[], workId: string): AozoraBookRow {
  const book = books.find((candidate) => candidate.workId === workId);
  if (book === undefined) {
    throw new Error(`fixture book ${workId} not found`);
  }
  return book;
}

describe("normalizeCatalogText", () => {
  // (1) NFKC folds full-width forms onto their canonical width.
  it("applies NFKC folding", () => {
    expect(normalizeCatalogText("ＡＢＣ１２３")).toBe("abc123");
    expect(normalizeCatalogText("ﾊﾝｶｸ")).toBe("はんかく");
  });

  // (2) Katakana is folded to hiragana so kana searches match either script.
  it("folds katakana to hiragana", () => {
    expect(normalizeCatalogText("ココロ")).toBe("こころ");
    expect(normalizeCatalogText("ゲンダイショウセツ")).toBe("げんだいしょうせつ");
  });

  // (3) Half- and full-width spaces (and punctuation/symbols) are stripped.
  it("strips half-width, full-width spaces and punctuation", () => {
    expect(normalizeCatalogText("夏目 漱石")).toBe("夏目漱石");
    expect(normalizeCatalogText("夏目　漱石")).toBe("夏目漱石");
    expect(normalizeCatalogText("こゝろ、（上）")).toBe("こゝろ上");
  });

  it("treats null/undefined as the empty string", () => {
    expect(normalizeCatalogText(null)).toBe("");
    expect(normalizeCatalogText(undefined)).toBe("");
  });
});

describe("parseCopyrightFlag", () => {
  // (4) あり → 1, なし → 0, anything else → 0.
  it("maps あり to 1 and なし to 0", () => {
    expect(parseCopyrightFlag("あり")).toBe(1);
    expect(parseCopyrightFlag("なし")).toBe(0);
  });

  it("defaults unknown/empty values to 0", () => {
    expect(parseCopyrightFlag("")).toBe(0);
    expect(parseCopyrightFlag(null)).toBe(0);
    expect(parseCopyrightFlag("不明")).toBe(0);
  });
});

describe("nullIfEmpty", () => {
  it("returns null for empty and whitespace, the value otherwise", () => {
    expect(nullIfEmpty("")).toBeNull();
    expect(nullIfEmpty("   ")).toBeNull();
    expect(nullIfEmpty(null)).toBeNull();
    expect(nullIfEmpty("値")).toBe("値");
  });
});

describe("stripBom", () => {
  // (5) A UTF-8 BOM-prefixed CSV still yields a readable header row.
  it("removes a leading BOM", () => {
    expect(stripBom("﻿hello")).toBe("hello");
    expect(stripBom("hello")).toBe("hello");
  });

  it("lets a BOM-prefixed CSV parse its header", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf8");
    const records = parseFixture(`﻿${raw}`);
    expect(records[0]["作品ID"]).toBe("000773");
  });
});

describe("chunk", () => {
  // (12) Chunk count and the trailing remainder are exact.
  it("splits into fixed-size chunks with a remainder", () => {
    const items = Array.from({ length: 450 }, (_, index) => index);
    const chunks = chunk(items, 200);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(200);
    expect(chunks[1]).toHaveLength(200);
    expect(chunks[2]).toHaveLength(50);
  });

  it("returns no chunks for an empty array and rejects a non-positive size", () => {
    expect(chunk([], 200)).toHaveLength(0);
    expect(() => chunk([1, 2], 0)).toThrow();
  });
});

describe("validateCatalogHeaders", () => {
  it("accepts the fixture headers", () => {
    expect(() => validateCatalogHeaders([...REQUIRED_HEADERS])).not.toThrow();
  });

  // (11) A missing required header fails the sync loudly.
  it("throws when a required header is missing", () => {
    const headers = REQUIRED_HEADERS.filter((header) => header !== "作品名");
    expect(() => validateCatalogHeaders([...headers])).toThrow(
      CatalogValidationError,
    );
    expect(() => validateCatalogHeaders([...headers])).toThrow(/作品名/);
  });
});

describe("buildGeneration", () => {
  it("combines the scheduled time and hash prefix, sortable by time", () => {
    const scheduledTime = Date.parse("2026-07-20T18:30:00.000Z");
    expect(buildGeneration(scheduledTime, "abcdef0123456789")).toBe(
      "20260720T183000Z-abcdef012345",
    );
  });
});

describe("aggregateCatalog (fixture)", () => {
  it("deduplicates works while keeping every distinct relation", () => {
    const records = loadFixtureRecords();
    const { books, contributors } = aggregateCatalog(records, GENERATION);

    // (9) Three 000773 rows (author, translator, exact-duplicate author)
    // collapse to one book; the duplicate author relation is dropped.
    expect(books.map((book) => book.workId).sort()).toEqual([
      "000123",
      "000773",
      "000999",
    ]);

    const kokoro = bookById(books, "000773");
    const kokoroContributors = contributors.filter(
      (row) => row.workId === "000773",
    );
    // (8) An author + a translator on the same work → two contributors.
    expect(kokoroContributors).toHaveLength(2);
    expect(kokoroContributors.map((row) => row.role).sort()).toEqual([
      "翻訳者",
      "著者",
    ]);
    // Ordinals are assigned in first-seen order (author before translator).
    expect(
      kokoroContributors.find((row) => row.role === "著者")?.ordinal,
    ).toBe(0);
    expect(
      kokoroContributors.find((row) => row.role === "翻訳者")?.ordinal,
    ).toBe(1);

    // (15) Zero-padded ids are preserved verbatim as TEXT.
    expect(kokoro.workId).toBe("000773");
    expect(
      kokoroContributors.find((row) => row.role === "著者")?.personId,
    ).toBe("000148");
  });

  it("carries the generation onto every row", () => {
    const { books, contributors } = aggregateCatalog(
      loadFixtureRecords(),
      GENERATION,
    );
    expect(books.every((book) => book.generation === GENERATION)).toBe(true);
    expect(
      contributors.every((row) => row.generation === GENERATION),
    ).toBe(true);
  });

  it("aggregates contributor display names onto the book", () => {
    const kokoro = bookById(
      aggregateCatalog(loadFixtureRecords(), GENERATION).books,
      "000773",
    );
    expect(kokoro.contributorNames).toContain("夏目 漱石");
    expect(kokoro.contributorNames).toContain("上田 敏");
    expect(kokoro.contributorNamesKana).toContain("なつめ そうせき");
  });

  // (6)(7) Quoted comma in a title and a quoted newline in a subtitle survive.
  it("preserves a quoted comma and a quoted newline from the CSV", () => {
    const yabu = bookById(
      aggregateCatalog(loadFixtureRecords(), GENERATION).books,
      "000123",
    );
    expect(yabu.title).toBe("藪の中,あるいは");
    expect(yabu.subtitle).toBe("上巻\n下巻");
  });

  // (13) search_text carries title, reading and contributor names (normalized).
  it("builds search_text from title, reading and contributor names", () => {
    const kokoro = bookById(
      aggregateCatalog(loadFixtureRecords(), GENERATION).books,
      "000773",
    );
    expect(kokoro.searchText).toContain("こころ");
    expect(kokoro.searchText).toContain("夏目漱石");
    expect(kokoro.searchText).toContain("うえだびん");
    // Romaji is folded to lowercase in the normalized search string.
    expect(kokoro.searchText).toContain("natsume");
  });

  it("normalizes the katakana reading to hiragana on the book", () => {
    const gendai = bookById(
      aggregateCatalog(loadFixtureRecords(), GENERATION).books,
      "000999",
    );
    expect(gendai.titleKana).toBe("ゲンダイショウセツ");
    expect(gendai.titleKanaNormalized).toBe("げんだいしょうせつ");
  });

  // (14) Empty URL cells become null; NOT NULL card_url stays a string.
  it("converts empty optional URLs to null", () => {
    const gendai = bookById(
      aggregateCatalog(loadFixtureRecords(), GENERATION).books,
      "000999",
    );
    expect(gendai.textUrl).toBeNull();
    expect(gendai.htmlUrl).toBeNull();
    expect(gendai.cardUrl).toBe(
      "https://www.aozora.gr.jp/cards/000500/card999.html",
    );
    expect(gendai.copyrighted).toBe(1);
  });
});

describe("aggregateCatalog (consistency)", () => {
  // (10) The same work id with contradictory work fields fails the sync.
  it("throws when a repeated work id disagrees on a work field", () => {
    const records: CatalogCsvRecord[] = [
      {
        作品ID: "000001",
        作品名: "タイトルA",
        図書カードURL: "https://example.test/a",
        人物ID: "000010",
        役割フラグ: "著者",
      },
      {
        作品ID: "000001",
        作品名: "タイトルB", // contradicts the first row
        図書カードURL: "https://example.test/a",
        人物ID: "000011",
        役割フラグ: "著者",
      },
    ];
    expect(() => aggregateCatalog(records, GENERATION)).toThrow(
      CatalogValidationError,
    );
    expect(() => aggregateCatalog(records, GENERATION)).toThrow(/000001/);
  });

  it("accepts a repeated work id whose work fields agree", () => {
    const records: CatalogCsvRecord[] = [
      {
        作品ID: "000001",
        作品名: "タイトルA",
        図書カードURL: "https://example.test/a",
        人物ID: "000010",
        役割フラグ: "著者",
      },
      {
        作品ID: "000001",
        作品名: "タイトルA",
        図書カードURL: "https://example.test/a",
        人物ID: "000011",
        役割フラグ: "翻訳者",
      },
    ];
    const { books, contributors } = aggregateCatalog(records, GENERATION);
    expect(books).toHaveLength(1);
    expect(contributors).toHaveLength(2);
  });
});
