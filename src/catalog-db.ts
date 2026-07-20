// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { normalizeCatalogText } from "./catalog";
import type { AozoraBookRow, AozoraContributorRow } from "./catalog";

/**
 * D1 access for the Aozora catalog sync: the single-row sync lock, sync-run
 * bookkeeping, generation-scoped chunk UPSERTs, post-load validation counts,
 * the atomic active-generation switch, and old-generation cleanup.
 *
 * Every write is generation-scoped or lock-guarded so a retried Workflow step
 * is idempotent, and the active pointer only ever moves once a full
 * generation is loaded and validated (src/catalog-workflow.ts).
 */

/** Snapshot of aozora_catalog_state row id=1 (camelCased). */
export interface CatalogState {
  activeGeneration: string | null;
  sourceSha256: string | null;
  sourceEtag: string | null;
  sourceLastModified: string | null;
  lastSuccessAt: string | null;
  activeBookCount: number;
  activeContributorCount: number;
  lockOwner: string | null;
  lockExpiresAt: string | null;
}

interface CatalogStateColumns {
  active_generation: string | null;
  source_sha256: string | null;
  source_etag: string | null;
  source_last_modified: string | null;
  last_success_at: string | null;
  active_book_count: number;
  active_contributor_count: number;
  lock_owner: string | null;
  lock_expires_at: string | null;
}

/** Source metadata recorded on the state row and sync-run on success. */
export interface CatalogSourceInfo {
  sha256: string;
  etag: string | null;
  lastModified: string | null;
}

/** Final counts persisted when a generation goes active. */
export interface CatalogActivation extends CatalogSourceInfo {
  generation: string;
  bookCount: number;
  contributorCount: number;
  successAt: string;
}

/** Reads the singleton state row; returns null only before migration. */
export async function getCatalogState(
  db: D1Database,
): Promise<CatalogState | null> {
  const row = await db
    .prepare(
      `SELECT active_generation, source_sha256, source_etag,
              source_last_modified, last_success_at, active_book_count,
              active_contributor_count, lock_owner, lock_expires_at
       FROM aozora_catalog_state
       WHERE id = 1`,
    )
    .first<CatalogStateColumns>();
  if (row === null) {
    return null;
  }
  return {
    activeGeneration: row.active_generation,
    sourceSha256: row.source_sha256,
    sourceEtag: row.source_etag,
    sourceLastModified: row.source_last_modified,
    lastSuccessAt: row.last_success_at,
    activeBookCount: row.active_book_count,
    activeContributorCount: row.active_contributor_count,
    lockOwner: row.lock_owner,
    lockExpiresAt: row.lock_expires_at,
  };
}

/**
 * Tries to take the sync lock via a conditional UPDATE: succeeds when the row
 * is unlocked, the lock has expired, or this run already holds it (retry).
 * Times compared as ISO-8601 UTC strings, which sort chronologically.
 * Returns { acquired } from the affected-row count.
 */
export async function acquireCatalogSyncLock(
  db: D1Database,
  runId: string,
  nowIso: string,
  expiresIso: string,
): Promise<{ acquired: boolean }> {
  const result = await db
    .prepare(
      `UPDATE aozora_catalog_state
       SET lock_owner = ?, lock_expires_at = ?
       WHERE id = 1
         AND (
           lock_owner IS NULL
           OR lock_expires_at IS NULL
           OR lock_expires_at < ?
           OR lock_owner = ?
         )`,
    )
    .bind(runId, expiresIso, nowIso, runId)
    .run();
  return { acquired: (result.meta.changes ?? 0) > 0 };
}

/** Releases the lock only if this run still owns it (no-op otherwise). */
export async function releaseCatalogSyncLock(
  db: D1Database,
  runId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE aozora_catalog_state
       SET lock_owner = NULL, lock_expires_at = NULL
       WHERE id = 1 AND lock_owner = ?`,
    )
    .bind(runId)
    .run();
}

/** Inserts (or re-inserts on retry) a sync-run row in the 'running' state. */
export async function beginCatalogSyncRun(
  db: D1Database,
  runId: string,
  sourceUrl: string,
  startedAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO aozora_catalog_sync_runs (run_id, status, source_url, started_at)
       VALUES (?, 'running', ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status = 'running',
         source_url = excluded.source_url,
         started_at = excluded.started_at,
         completed_at = NULL,
         error_message = NULL`,
    )
    .bind(runId, sourceUrl, startedAt)
    .run();
}

/** Records a run that found no lock available; no work was performed. */
export async function markCatalogSyncSkipped(
  db: D1Database,
  runId: string,
  sourceUrl: string,
  at: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO aozora_catalog_sync_runs
         (run_id, status, source_url, started_at, completed_at)
       VALUES (?, 'skipped_locked', ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status = 'skipped_locked',
         completed_at = excluded.completed_at`,
    )
    .bind(runId, sourceUrl, at, at)
    .run();
}

/** Marks the run 'unchanged' (source matched the stored hash/validators). */
export async function markCatalogSyncUnchanged(
  db: D1Database,
  runId: string,
  source: Partial<CatalogSourceInfo>,
  at: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE aozora_catalog_sync_runs
       SET status = 'unchanged',
           source_sha256 = ?,
           source_etag = ?,
           source_last_modified = ?,
           completed_at = ?
       WHERE run_id = ?`,
    )
    .bind(
      source.sha256 ?? null,
      source.etag ?? null,
      source.lastModified ?? null,
      at,
      runId,
    )
    .run();
}

/** Marks the run 'failed' and stores a truncated error message. */
export async function markCatalogSyncFailed(
  db: D1Database,
  runId: string,
  message: string,
  at: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE aozora_catalog_sync_runs
       SET status = 'failed', error_message = ?, completed_at = ?
       WHERE run_id = ?`,
    )
    .bind(message.slice(0, 2_000), at, runId)
    .run();
}

/** Fields written to the sync-run row when a generation completes. */
export interface CatalogRunCompletion {
  generation: string;
  source: CatalogSourceInfo;
  sourceRowCount: number;
  bookCount: number;
  contributorCount: number;
  completedAt: string;
}

/** Marks the run 'completed' with the loaded counts and source metadata. */
export async function markCatalogSyncCompleted(
  db: D1Database,
  runId: string,
  completion: CatalogRunCompletion,
): Promise<void> {
  await db
    .prepare(
      `UPDATE aozora_catalog_sync_runs
       SET status = 'completed',
           generation = ?,
           source_sha256 = ?,
           source_etag = ?,
           source_last_modified = ?,
           source_row_count = ?,
           book_count = ?,
           contributor_count = ?,
           completed_at = ?
       WHERE run_id = ?`,
    )
    .bind(
      completion.generation,
      completion.source.sha256,
      completion.source.etag,
      completion.source.lastModified,
      completion.sourceRowCount,
      completion.bookCount,
      completion.contributorCount,
      completion.completedAt,
      runId,
    )
    .run();
}

// Column order shared by the INSERT and its VALUES placeholders. Kept as one
// source of truth so a schema change touches a single list.
const BOOK_COLUMNS = [
  "generation",
  "work_id",
  "title",
  "title_kana",
  "title_sort",
  "subtitle",
  "subtitle_kana",
  "original_title",
  "first_appearance",
  "ndc",
  "orthography",
  "copyrighted",
  "published_on",
  "updated_on",
  "card_url",
  "inputter",
  "proofreader",
  "text_url",
  "text_updated_on",
  "text_encoding",
  "html_url",
  "html_updated_on",
  "html_encoding",
  "contributor_names",
  "contributor_names_kana",
  "title_normalized",
  "title_kana_normalized",
  "contributor_names_normalized",
  "contributor_names_kana_normalized",
  "search_text",
] as const;

const BOOK_UPSERT_SQL = buildUpsertSql(
  "aozora_books",
  BOOK_COLUMNS,
  ["generation", "work_id"],
);

const CONTRIBUTOR_COLUMNS = [
  "generation",
  "work_id",
  "person_id",
  "role",
  "ordinal",
  "last_name",
  "first_name",
  "last_name_kana",
  "first_name_kana",
  "last_name_sort",
  "first_name_sort",
  "last_name_romaji",
  "first_name_romaji",
  "born_on",
  "died_on",
  "copyrighted",
  "display_name",
  "display_name_kana",
  "name_normalized",
  "name_kana_normalized",
] as const;

const CONTRIBUTOR_UPSERT_SQL = buildUpsertSql(
  "aozora_book_contributors",
  CONTRIBUTOR_COLUMNS,
  ["generation", "work_id", "person_id", "role"],
);

/**
 * Builds an "INSERT ... ON CONFLICT(pk) DO UPDATE SET col=excluded.col"
 * statement. The UPSERT makes a retried load-chunk step idempotent within its
 * generation (a fresh generation never collides with active data).
 */
function buildUpsertSql(
  table: string,
  columns: readonly string[],
  primaryKey: readonly string[],
): string {
  const placeholders = columns.map(() => "?").join(", ");
  const pkSet = new Set<string>(primaryKey);
  const updates = columns
    .filter((column) => !pkSet.has(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${primaryKey.join(", ")}) DO UPDATE SET ${updates}`
  );
}

/**
 * UPSERTs one book chunk in a single db.batch() (atomic): every row is its
 * own bound statement (<= 30 params each), so a 200-row chunk stays well
 * under D1's per-statement param cap and per-invocation query cap.
 */
export async function upsertBookChunk(
  db: D1Database,
  books: readonly AozoraBookRow[],
): Promise<void> {
  if (books.length === 0) {
    return;
  }
  const statement = db.prepare(BOOK_UPSERT_SQL);
  await db.batch(
    books.map((book) =>
      statement.bind(
        book.generation,
        book.workId,
        book.title,
        book.titleKana,
        book.titleSort,
        book.subtitle,
        book.subtitleKana,
        book.originalTitle,
        book.firstAppearance,
        book.ndc,
        book.orthography,
        book.copyrighted,
        book.publishedOn,
        book.updatedOn,
        book.cardUrl,
        book.inputter,
        book.proofreader,
        book.textUrl,
        book.textUpdatedOn,
        book.textEncoding,
        book.htmlUrl,
        book.htmlUpdatedOn,
        book.htmlEncoding,
        book.contributorNames,
        book.contributorNamesKana,
        book.titleNormalized,
        book.titleKanaNormalized,
        book.contributorNamesNormalized,
        book.contributorNamesKanaNormalized,
        book.searchText,
      ),
    ),
  );
}

/** UPSERTs one contributor chunk in a single atomic db.batch(). */
export async function upsertContributorChunk(
  db: D1Database,
  contributors: readonly AozoraContributorRow[],
): Promise<void> {
  if (contributors.length === 0) {
    return;
  }
  const statement = db.prepare(CONTRIBUTOR_UPSERT_SQL);
  await db.batch(
    contributors.map((contributor) =>
      statement.bind(
        contributor.generation,
        contributor.workId,
        contributor.personId,
        contributor.role,
        contributor.ordinal,
        contributor.lastName,
        contributor.firstName,
        contributor.lastNameKana,
        contributor.firstNameKana,
        contributor.lastNameSort,
        contributor.firstNameSort,
        contributor.lastNameRomaji,
        contributor.firstNameRomaji,
        contributor.bornOn,
        contributor.diedOn,
        contributor.copyrighted,
        contributor.displayName,
        contributor.displayNameKana,
        contributor.nameNormalized,
        contributor.nameKanaNormalized,
      ),
    ),
  );
}

/** Counts per generation used by post-load validation. */
export interface CatalogGenerationCounts {
  bookCount: number;
  contributorCount: number;
  cardUrlCount: number;
}

/** Reads the loaded-row counts for a generation before it goes active. */
export async function countGeneration(
  db: D1Database,
  generation: string,
): Promise<CatalogGenerationCounts> {
  const books = await db
    .prepare(`SELECT COUNT(*) AS count FROM aozora_books WHERE generation = ?`)
    .bind(generation)
    .first<{ count: number }>();
  const contributors = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM aozora_book_contributors WHERE generation = ?`,
    )
    .bind(generation)
    .first<{ count: number }>();
  const cardUrls = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM aozora_books
       WHERE generation = ? AND card_url IS NOT NULL AND card_url <> ''`,
    )
    .bind(generation)
    .first<{ count: number }>();
  return {
    bookCount: books?.count ?? 0,
    contributorCount: contributors?.count ?? 0,
    cardUrlCount: cardUrls?.count ?? 0,
  };
}

/**
 * Atomically points active_generation at the new generation and clears the
 * lock, guarded by lock ownership. This single UPDATE is the instant the
 * *_active views begin returning the new data.
 *
 * Idempotent under a step retry: the UPDATE also clears lock_owner, so a
 * retry (the response was lost after the commit) affects 0 rows. That alone
 * is indistinguishable from "lock lost before activation", so before treating
 * 0 rows as failure we re-read the state — if active_generation already equals
 * ours, the switch happened on the earlier attempt and we report success.
 */
export async function activateGeneration(
  db: D1Database,
  runId: string,
  activation: CatalogActivation,
): Promise<{ activated: boolean }> {
  const result = await db
    .prepare(
      `UPDATE aozora_catalog_state
       SET active_generation = ?,
           source_sha256 = ?,
           source_etag = ?,
           source_last_modified = ?,
           last_success_at = ?,
           active_book_count = ?,
           active_contributor_count = ?,
           lock_owner = NULL,
           lock_expires_at = NULL
       WHERE id = 1 AND lock_owner = ?`,
    )
    .bind(
      activation.generation,
      activation.sha256,
      activation.etag,
      activation.lastModified,
      activation.successAt,
      activation.bookCount,
      activation.contributorCount,
      runId,
    )
    .run();
  if ((result.meta.changes ?? 0) > 0) {
    return { activated: true };
  }
  // Absorb a post-commit retry: a prior attempt may have already switched.
  const state = await getCatalogState(db);
  return { activated: state?.activeGeneration === activation.generation };
}

/**
 * Deletes every generation except the given one (contributors first for the
 * FK). Best-effort by design: the *_active views only read active_generation,
 * so leftover rows never corrupt results and the next sync retries cleanup.
 */
export async function deleteOldGenerations(
  db: D1Database,
  keepGeneration: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM aozora_book_contributors WHERE generation <> ?`,
    )
    .bind(keepGeneration)
    .run();
  await db
    .prepare(`DELETE FROM aozora_books WHERE generation <> ?`)
    .bind(keepGeneration)
    .run();
}

/**
 * A single GET /api/books hit, camelCased for the JSON response. htmlUrl is
 * always a non-empty string: searchBooks filters out catalogue rows without
 * HTML (~0.5%, unconvertible), so every hit points at real body text.
 */
export interface BookSearchResult {
  workId: string;
  title: string;
  subtitle: string | null;
  author: string;
  htmlUrl: string;
  cardUrl: string;
  copyrighted: boolean;
}

/** Raw column shape returned by BOOK_SEARCH_SQL (snake_case, D1 integers). */
interface BookSearchRow {
  work_id: string;
  title: string;
  subtitle: string | null;
  contributor_names: string;
  copyrighted: number;
  html_url: string;
  card_url: string;
}

/**
 * Pure snake_case -> camelCase row mapper. author is contributor_names
 * verbatim (already display-formatted at sync time); copyrighted is the D1
 * integer flag as a boolean. Split out from searchBooks so it is
 * unit-testable without a D1 binding.
 */
export function mapBookRow(row: BookSearchRow): BookSearchResult {
  return {
    workId: row.work_id,
    title: row.title,
    subtitle: row.subtitle,
    author: row.contributor_names,
    htmlUrl: row.html_url,
    cardUrl: row.card_url,
    copyrighted: row.copyrighted === 1,
  };
}

export const DEFAULT_BOOK_SEARCH_LIMIT = 50;
export const MAX_BOOK_SEARCH_LIMIT = 50;

/**
 * Parses ?limit=. Absent, blank, or invalid (non-numeric, non-integer, < 1)
 * falls back to DEFAULT_BOOK_SEARCH_LIMIT; anything above
 * MAX_BOOK_SEARCH_LIMIT is clamped down to it.
 */
export function clampBookSearchLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") {
    return DEFAULT_BOOK_SEARCH_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_BOOK_SEARCH_LIMIT;
  }
  return Math.min(value, MAX_BOOK_SEARCH_LIMIT);
}

/**
 * Normalizes a raw ?q= value with normalizeCatalogText -- the same rule that
 * built the search_text / *_normalized columns, so a query matches iff its
 * normalized form is a substring. Returns "" when the query is missing or
 * reduces to nothing (blank, punctuation- or symbol-only); the handler turns
 * that into an empty result set without touching D1. Because normalization
 * strips LIKE metacharacters (% _), the value is safe to concatenate into the
 * pattern without ESCAPE.
 */
export function normalizeBookSearchQuery(raw: string | null): string {
  return normalizeCatalogText(raw);
}

/**
 * Substring search over aozora_books_active (always the view, so a
 * half-loaded sync generation is invisible). The normalized query is bound as
 * ?1 and reused three times: the search_text substring filter plus two prefix
 * probes that rank title-prefix matches (0) above author-prefix matches (1)
 * above plain substring hits (2), then shortest normalized title, then
 * title order. Rows without HTML (html_url null/empty) are excluded so
 * htmlUrl is always present. ?2 is the row limit.
 */
export const BOOK_SEARCH_SQL =
  "SELECT work_id, title, subtitle, contributor_names, copyrighted, html_url, card_url " +
  "FROM aozora_books_active " +
  "WHERE search_text LIKE '%' || ?1 || '%' " +
  "  AND html_url IS NOT NULL AND html_url <> '' " +
  "ORDER BY " +
  "  CASE " +
  "    WHEN title_normalized LIKE ?1 || '%' THEN 0 " +
  "    WHEN contributor_names_normalized LIKE ?1 || '%' THEN 1 " +
  "    ELSE 2 " +
  "  END, " +
  "  length(title_normalized), " +
  "  title_normalized " +
  "LIMIT ?2";

/**
 * Runs BOOK_SEARCH_SQL against the active generation. normalizedQuery must
 * already be normalized (normalizeBookSearchQuery) and non-empty -- the caller
 * short-circuits the empty case before reaching D1. Returns camelCased hits.
 */
export async function searchBooks(
  db: D1Database,
  normalizedQuery: string,
  limit: number,
): Promise<BookSearchResult[]> {
  const result = await db
    .prepare(BOOK_SEARCH_SQL)
    .bind(normalizedQuery, limit)
    .all<BookSearchRow>();
  return result.results.map(mapBookRow);
}
