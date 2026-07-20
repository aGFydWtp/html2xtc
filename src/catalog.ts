// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Pure catalog logic for the Aozora Bunko sync: header validation, text
 * normalization, boolean/null coercion, aggregation of the one-row-per
 * work-person CSV into deduplicated books + contributors, search-text
 * assembly, generation-string building, and chunk splitting.
 *
 * Deliberately free of cloudflare:* / @cloudflare/* / fflate / papaparse
 * imports so every rule here is unit-testable under plain vitest. The
 * Workflow (src/catalog-workflow.ts) unzips + parses and feeds the parsed
 * records in; D1 I/O lives in src/catalog-db.ts.
 */

/**
 * A parsed CSV record keyed by header name. The source CSV is
 * one-row-per-(work, person) relation, so many records share a work_id.
 * Values are always strings (papaparse with header:true); a missing cell
 * is the empty string.
 */
export type CatalogCsvRecord = Record<string, string>;

/**
 * Raised for deterministic, non-retryable defects in the source CSV
 * (missing headers, per-work field contradictions, ...). The Workflow
 * rethrows these as NonRetryableError — retrying the same bytes is futile.
 */
export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

/**
 * CSV header names used to build a book row. Read by name, never by column
 * index, so the sync survives column additions / reordering in the official
 * file (a missing header fails the sync instead).
 */
export const BOOK_HEADERS = {
  workId: "作品ID",
  title: "作品名",
  titleKana: "作品名読み",
  titleSort: "ソート用読み",
  subtitle: "副題",
  subtitleKana: "副題読み",
  originalTitle: "原題",
  firstAppearance: "初出",
  ndc: "分類番号",
  orthography: "文字遣い種別",
  copyrighted: "作品著作権フラグ",
  publishedOn: "公開日",
  updatedOn: "最終更新日",
  cardUrl: "図書カードURL",
  inputter: "入力者",
  proofreader: "校正者",
  textUrl: "テキストファイルURL",
  textUpdatedOn: "テキストファイル最終更新日",
  textEncoding: "テキストファイル符号化方式",
  htmlUrl: "XHTML/HTMLファイルURL",
  htmlUpdatedOn: "XHTML/HTMLファイル最終更新日",
  htmlEncoding: "XHTML/HTMLファイル符号化方式",
} as const;

/** CSV header names used to build a contributor (person-relation) row. */
export const PERSON_HEADERS = {
  personId: "人物ID",
  lastName: "姓",
  firstName: "名",
  lastNameKana: "姓読み",
  firstNameKana: "名読み",
  lastNameSort: "姓読みソート用",
  firstNameSort: "名読みソート用",
  lastNameRomaji: "姓ローマ字",
  firstNameRomaji: "名ローマ字",
  role: "役割フラグ",
  bornOn: "生年月日",
  diedOn: "没年月日",
  copyrighted: "人物著作権フラグ",
} as const;

/** Every header the sync depends on; a missing one fails validation. */
export const REQUIRED_HEADERS: readonly string[] = [
  ...Object.values(BOOK_HEADERS),
  ...Object.values(PERSON_HEADERS),
];

/**
 * Work-level headers whose value must agree across every row that shares a
 * work_id. A disagreement signals a corrupt source file or a parser column
 * shift, so the sync fails rather than silently keeping the first value.
 */
const WORK_CONSISTENCY_HEADERS: readonly string[] = [
  BOOK_HEADERS.title,
  BOOK_HEADERS.titleKana,
  BOOK_HEADERS.subtitle,
  BOOK_HEADERS.ndc,
  BOOK_HEADERS.publishedOn,
  BOOK_HEADERS.cardUrl,
  BOOK_HEADERS.textUrl,
  BOOK_HEADERS.htmlUrl,
];

export interface AozoraBookRow {
  generation: string;
  workId: string;
  title: string;
  titleKana: string | null;
  titleSort: string | null;
  subtitle: string | null;
  subtitleKana: string | null;
  originalTitle: string | null;
  firstAppearance: string | null;
  ndc: string | null;
  orthography: string | null;
  copyrighted: number;
  publishedOn: string | null;
  updatedOn: string | null;
  cardUrl: string;
  inputter: string | null;
  proofreader: string | null;
  textUrl: string | null;
  textUpdatedOn: string | null;
  textEncoding: string | null;
  htmlUrl: string | null;
  htmlUpdatedOn: string | null;
  htmlEncoding: string | null;
  contributorNames: string;
  contributorNamesKana: string;
  titleNormalized: string;
  titleKanaNormalized: string;
  contributorNamesNormalized: string;
  contributorNamesKanaNormalized: string;
  searchText: string;
}

export interface AozoraContributorRow {
  generation: string;
  workId: string;
  personId: string;
  role: string;
  ordinal: number;
  lastName: string | null;
  firstName: string | null;
  lastNameKana: string | null;
  firstNameKana: string | null;
  lastNameSort: string | null;
  firstNameSort: string | null;
  lastNameRomaji: string | null;
  firstNameRomaji: string | null;
  bornOn: string | null;
  diedOn: string | null;
  copyrighted: number;
  displayName: string;
  displayNameKana: string;
  nameNormalized: string;
  nameKanaNormalized: string;
}

export interface AggregatedCatalog {
  books: AozoraBookRow[];
  contributors: AozoraContributorRow[];
}

/**
 * Normalizes a string for indexed / substring search:
 * NFKC → lowercase → katakana-to-hiragana → strip punctuation, symbols and
 * whitespace. The display columns keep the original text; only the
 * *_normalized columns and search_text run through here. If this rule ever
 * changes, a re-sync is required even when the source CSV is unchanged.
 */
export function normalizeCatalogText(
  value: string | null | undefined,
): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0x60),
    )
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

/**
 * Aozora's あり/なし copyright flag → 1/0. Anything that is not exactly あり
 * (including empty) is treated as 0 (public domain), the safe default for a
 * downstream "can I show the text" check.
 */
export function parseCopyrightFlag(value: string | null | undefined): number {
  return (value ?? "").trim() === "あり" ? 1 : 0;
}

/** Empty (or whitespace-only) string → null, for nullable D1 columns. */
export function nullIfEmpty(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Removes a leading UTF-8 BOM (U+FEFF) if present; otherwise returns as-is. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Splits an array into fixed-size chunks (last chunk holds the remainder). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(`chunk size must be positive, got ${size}`);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Throws CatalogValidationError if any required header is absent. Called with
 * the header row before aggregation so a spec change fails loudly rather than
 * yielding empty columns.
 */
export function validateCatalogHeaders(headers: readonly string[]): void {
  const present = new Set(headers);
  const missing = REQUIRED_HEADERS.filter((header) => !present.has(header));
  if (missing.length > 0) {
    throw new CatalogValidationError(
      `missing required CSV header(s): ${missing.join(", ")}`,
    );
  }
}

/**
 * Builds a generation id from the scheduled time and the source hash, e.g.
 * "20260720T183000Z-a1b2c3d4e5f6". Sortable by time, and the hash suffix
 * keeps two same-minute runs of different sources distinct.
 */
export function buildGeneration(
  scheduledTime: number,
  sourceSha256: string,
): string {
  const stamp = new Date(scheduledTime)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${sourceSha256.slice(0, 12)}`;
}

/** Joins present name parts with a single space (drops empties). */
function joinName(...parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null && part !== "").join(" ");
}

/** Space-joins non-empty normalized fragments into one search string. */
function joinNormalized(...values: Array<string | null | undefined>): string {
  return values
    .map((value) => normalizeCatalogText(value))
    .filter((value) => value.length > 0)
    .join(" ");
}

/** Mutable per-work accumulator; frozen into an AozoraBookRow at the end. */
interface MutableBook {
  record: CatalogCsvRecord;
  displayNames: string[];
  displayNamesKana: string[];
  romajiNames: string[];
}

function relationKey(workId: string, personId: string, role: string): string {
  // NUL separator: cannot appear inside a CSV field, so the composite key is
  // unambiguous even if an id or role contained a delimiter-like character.
  return `${workId} ${personId} ${role}`;
}

/**
 * Aggregates the one-row-per-relation records into deduplicated book rows and
 * contributor rows for a single generation.
 *
 * - Books are keyed by work_id; repeated rows must agree on the work-level
 *   fields (WORK_CONSISTENCY_HEADERS) or a CatalogValidationError is thrown.
 * - Contributors are keyed by (work_id, person_id, role) and deduplicated;
 *   ordinal counts distinct relations per work in first-seen order.
 * - Each book's contributor_names / _kana and search_text are assembled from
 *   its contributors after all rows are seen.
 */
export function aggregateCatalog(
  records: readonly CatalogCsvRecord[],
  generation: string,
): AggregatedCatalog {
  const books = new Map<string, MutableBook>();
  const seenRelations = new Set<string>();
  const contributors: AozoraContributorRow[] = [];
  const ordinalByWork = new Map<string, number>();

  for (const record of records) {
    const workId = (record[BOOK_HEADERS.workId] ?? "").trim();
    if (workId === "") {
      // A relation with no work id cannot be attached to any book; skip it
      // rather than fabricating a key.
      continue;
    }

    let book = books.get(workId);
    if (book === undefined) {
      book = {
        record,
        displayNames: [],
        displayNamesKana: [],
        romajiNames: [],
      };
      books.set(workId, book);
    } else {
      assertWorkConsistency(workId, book.record, record);
    }

    const personId = (record[PERSON_HEADERS.personId] ?? "").trim();
    const role = (record[PERSON_HEADERS.role] ?? "").trim();
    if (personId === "") {
      // Work with no person on this row (rare); nothing to add to the
      // contributor set.
      continue;
    }

    const key = relationKey(workId, personId, role);
    if (seenRelations.has(key)) {
      // Duplicate (work, person, role) relation — collapse to one row.
      continue;
    }
    seenRelations.add(key);

    const ordinal = ordinalByWork.get(workId) ?? 0;
    ordinalByWork.set(workId, ordinal + 1);

    const contributor = buildContributor(record, generation, workId, personId, role, ordinal);
    contributors.push(contributor);

    if (contributor.displayName !== "") {
      book.displayNames.push(contributor.displayName);
    }
    if (contributor.displayNameKana !== "") {
      book.displayNamesKana.push(contributor.displayNameKana);
    }
    const romaji = joinName(contributor.lastNameRomaji, contributor.firstNameRomaji);
    if (romaji !== "") {
      book.romajiNames.push(romaji);
    }
  }

  const bookRows: AozoraBookRow[] = [];
  for (const [workId, book] of books) {
    bookRows.push(buildBook(book, generation, workId));
  }

  return { books: bookRows, contributors };
}

function assertWorkConsistency(
  workId: string,
  first: CatalogCsvRecord,
  next: CatalogCsvRecord,
): void {
  for (const header of WORK_CONSISTENCY_HEADERS) {
    const a = (first[header] ?? "").trim();
    const b = (next[header] ?? "").trim();
    if (a !== b) {
      throw new CatalogValidationError(
        `inconsistent "${header}" for work ${workId}: "${a}" vs "${b}"`,
      );
    }
  }
}

function buildContributor(
  record: CatalogCsvRecord,
  generation: string,
  workId: string,
  personId: string,
  role: string,
  ordinal: number,
): AozoraContributorRow {
  const lastName = nullIfEmpty(record[PERSON_HEADERS.lastName]);
  const firstName = nullIfEmpty(record[PERSON_HEADERS.firstName]);
  const lastNameKana = nullIfEmpty(record[PERSON_HEADERS.lastNameKana]);
  const firstNameKana = nullIfEmpty(record[PERSON_HEADERS.firstNameKana]);

  const displayName = joinName(lastName, firstName);
  const displayNameKana = joinName(lastNameKana, firstNameKana);

  return {
    generation,
    workId,
    personId,
    role,
    ordinal,
    lastName,
    firstName,
    lastNameKana,
    firstNameKana,
    lastNameSort: nullIfEmpty(record[PERSON_HEADERS.lastNameSort]),
    firstNameSort: nullIfEmpty(record[PERSON_HEADERS.firstNameSort]),
    lastNameRomaji: nullIfEmpty(record[PERSON_HEADERS.lastNameRomaji]),
    firstNameRomaji: nullIfEmpty(record[PERSON_HEADERS.firstNameRomaji]),
    bornOn: nullIfEmpty(record[PERSON_HEADERS.bornOn]),
    diedOn: nullIfEmpty(record[PERSON_HEADERS.diedOn]),
    copyrighted: parseCopyrightFlag(record[PERSON_HEADERS.copyrighted]),
    displayName,
    displayNameKana,
    nameNormalized: normalizeCatalogText(joinName(lastName, firstName)),
    nameKanaNormalized: normalizeCatalogText(joinName(lastNameKana, firstNameKana)),
  };
}

function buildBook(
  book: MutableBook,
  generation: string,
  workId: string,
): AozoraBookRow {
  const record = book.record;

  const title = (record[BOOK_HEADERS.title] ?? "").trim();
  const titleKana = nullIfEmpty(record[BOOK_HEADERS.titleKana]);
  const subtitle = nullIfEmpty(record[BOOK_HEADERS.subtitle]);
  const subtitleKana = nullIfEmpty(record[BOOK_HEADERS.subtitleKana]);
  const originalTitle = nullIfEmpty(record[BOOK_HEADERS.originalTitle]);
  const ndc = nullIfEmpty(record[BOOK_HEADERS.ndc]);

  const contributorNames = book.displayNames.join(" ");
  const contributorNamesKana = book.displayNamesKana.join(" ");

  return {
    generation,
    workId,
    title,
    titleKana,
    titleSort: nullIfEmpty(record[BOOK_HEADERS.titleSort]),
    subtitle,
    subtitleKana,
    originalTitle,
    firstAppearance: nullIfEmpty(record[BOOK_HEADERS.firstAppearance]),
    ndc,
    orthography: nullIfEmpty(record[BOOK_HEADERS.orthography]),
    copyrighted: parseCopyrightFlag(record[BOOK_HEADERS.copyrighted]),
    publishedOn: nullIfEmpty(record[BOOK_HEADERS.publishedOn]),
    updatedOn: nullIfEmpty(record[BOOK_HEADERS.updatedOn]),
    // card_url is NOT NULL; empty is preserved as "" (schema permits it)
    // rather than becoming NULL, which the column forbids.
    cardUrl: (record[BOOK_HEADERS.cardUrl] ?? "").trim(),
    inputter: nullIfEmpty(record[BOOK_HEADERS.inputter]),
    proofreader: nullIfEmpty(record[BOOK_HEADERS.proofreader]),
    textUrl: nullIfEmpty(record[BOOK_HEADERS.textUrl]),
    textUpdatedOn: nullIfEmpty(record[BOOK_HEADERS.textUpdatedOn]),
    textEncoding: nullIfEmpty(record[BOOK_HEADERS.textEncoding]),
    htmlUrl: nullIfEmpty(record[BOOK_HEADERS.htmlUrl]),
    htmlUpdatedOn: nullIfEmpty(record[BOOK_HEADERS.htmlUpdatedOn]),
    htmlEncoding: nullIfEmpty(record[BOOK_HEADERS.htmlEncoding]),
    contributorNames,
    contributorNamesKana,
    titleNormalized: normalizeCatalogText(title),
    titleKanaNormalized: normalizeCatalogText(titleKana),
    contributorNamesNormalized: normalizeCatalogText(contributorNames),
    contributorNamesKanaNormalized: normalizeCatalogText(contributorNamesKana),
    searchText: joinNormalized(
      title,
      titleKana,
      subtitle,
      subtitleKana,
      originalTitle,
      book.displayNames.join(" "),
      book.displayNamesKana.join(" "),
      book.romajiNames.join(" "),
      ndc,
    ),
  };
}
