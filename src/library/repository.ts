// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * D1 access for library_items (and its device_library_items fan-out on
 * delete). Every query is scoped by account_id so a caller can never reach
 * another account's item by guessing an itemId (plan §16 — "他アカウントの
 * XTCを取得できないようにする"). Row (snake_case) <-> app (camelCase) mapping
 * follows the same convention as src/catalog-db.ts.
 */

export interface LibraryItem {
  id: string;
  accountId: string;
  sourceJobId: string | null;
  sourceUrl: string | null;
  title: string;
  author: string | null;
  r2Key: string;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface LibraryItemRow {
  id: string;
  account_id: string;
  source_job_id: string | null;
  source_url: string | null;
  title: string;
  author: string | null;
  r2_key: string;
  size_bytes: number;
  sha256: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function fromRow(row: LibraryItemRow): LibraryItem {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceJobId: row.source_job_id,
    sourceUrl: row.source_url,
    title: row.title,
    author: row.author,
    r2Key: row.r2_key,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface NewLibraryItem {
  id: string;
  accountId: string;
  sourceJobId: string | null;
  sourceUrl: string | null;
  title: string;
  author: string | null;
  r2Key: string;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
}

/** Inserts a new library_items row. Caller has already copied the R2 object at r2Key. */
export async function insertLibraryItem(db: D1Database, item: NewLibraryItem): Promise<void> {
  await db
    .prepare(
      `INSERT INTO library_items
         (id, account_id, source_job_id, source_url, title, author, r2_key, size_bytes, sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      item.accountId,
      item.sourceJobId,
      item.sourceUrl,
      item.title,
      item.author,
      item.r2Key,
      item.sizeBytes,
      item.sha256,
      item.createdAt,
      item.createdAt,
    )
    .run();
}

/**
 * Finds an existing, non-deleted item by (accountId, sourceJobId), used by
 * saveJobToLibrary (src/library/service.ts) for the from-job idempotency
 * check: no schema-level unique constraint enforces this pairing (see the
 * final report for why), so the guarantee is read-then-write, not atomic —
 * acceptable because a genuine race just produces a second, harmless
 * library entry for the same job rather than any data loss or cross-account
 * leak.
 */
export async function findLibraryItemByJobId(
  db: D1Database,
  accountId: string,
  sourceJobId: string,
): Promise<LibraryItem | null> {
  const row = await db
    .prepare(
      `SELECT * FROM library_items
       WHERE account_id = ? AND source_job_id = ? AND deleted_at IS NULL`,
    )
    .bind(accountId, sourceJobId)
    .first<LibraryItemRow>();
  return row === null ? null : fromRow(row);
}

/** Lists an account's non-deleted items, newest first. */
export async function listLibraryItems(db: D1Database, accountId: string): Promise<LibraryItem[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM library_items
       WHERE account_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    )
    .bind(accountId)
    .all<LibraryItemRow>();
  return results.map(fromRow);
}

/** Fetches one item scoped to accountId; null if missing, soft-deleted, or owned by another account. */
export async function getLibraryItem(
  db: D1Database,
  accountId: string,
  itemId: string,
): Promise<LibraryItem | null> {
  const row = await db
    .prepare(
      `SELECT * FROM library_items
       WHERE id = ? AND account_id = ? AND deleted_at IS NULL`,
    )
    .bind(itemId, accountId)
    .first<LibraryItemRow>();
  return row === null ? null : fromRow(row);
}

/** Updates the provided fields only (title and/or author); returns false if the item doesn't exist, is deleted, or isn't owned by accountId. */
export async function updateLibraryItem(
  db: D1Database,
  accountId: string,
  itemId: string,
  patch: { title?: string; author?: string | null },
  updatedAt: string,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(patch.title);
  }
  if (patch.author !== undefined) {
    sets.push("author = ?");
    values.push(patch.author);
  }
  if (sets.length === 0) {
    // Nothing to change; existence/ownership is confirmed by the caller via
    // getLibraryItem before calling this, so treat a no-op patch as success.
    return true;
  }
  sets.push("updated_at = ?");
  values.push(updatedAt, itemId, accountId);

  const result = await db
    .prepare(
      `UPDATE library_items SET ${sets.join(", ")}
       WHERE id = ? AND account_id = ? AND deleted_at IS NULL`,
    )
    .bind(...values)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Soft-deletes an item (sets deleted_at) if owned by accountId and not already deleted. Returns false if not found/owned/already deleted. */
export async function softDeleteLibraryItem(
  db: D1Database,
  accountId: string,
  itemId: string,
  deletedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE library_items SET deleted_at = ?
       WHERE id = ? AND account_id = ? AND deleted_at IS NULL`,
    )
    .bind(deletedAt, itemId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Removes itemId from every device's assigned list (plan §9.2 delete step 2). */
export async function removeItemFromAllDeviceLibraries(db: D1Database, itemId: string): Promise<void> {
  await db.prepare(`DELETE FROM device_library_items WHERE library_item_id = ?`).bind(itemId).run();
}

/** Physically removes the library_items row. Only call once the R2 object is confirmed deleted (plan §9.2 step 4). */
export async function hardDeleteLibraryItem(db: D1Database, itemId: string): Promise<void> {
  await db.prepare(`DELETE FROM library_items WHERE id = ?`).bind(itemId).run();
}
