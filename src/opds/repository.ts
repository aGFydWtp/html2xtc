// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * D1 access for the OPDS routes (plan §10): listing a device's assigned,
 * non-deleted library items (position-ordered), the same list filtered by a
 * LIKE search term, and resolving one assigned item for download. Kept
 * separate from src/devices/repository.ts's listDeviceLibraryItems (the
 * Cookie-authenticated device-library-editor API) so neither module's
 * query shape or column list is constrained by the other's needs — this one
 * always includes updated_at (for the feed's <updated>) and fetches one
 * extra row per page for trimPage's hasNext check (src/opds/feed.ts).
 */

export interface OpdsItemRow {
  id: string;
  title: string;
  author: string | null;
  updatedAt: string;
}

interface RawOpdsItemRow {
  id: string;
  title: string;
  author: string | null;
  updated_at: string;
}

function fromRow(row: RawOpdsItemRow): OpdsItemRow {
  return { id: row.id, title: row.title, author: row.author, updatedAt: row.updated_at };
}

export interface FetchWindow {
  /** Rows requested — callers pass pageSize + 1 so trimPage can detect a next page without a COUNT(*) query. */
  limit: number;
  offset: number;
}

/**
 * Lists a device's assigned, non-deleted items in device_library_items
 * position order (plan §10.1 "position順に返す"), one window of rows at a
 * time.
 */
export async function listAssignedLibraryItems(
  db: D1Database,
  deviceId: string,
  window: FetchWindow,
): Promise<OpdsItemRow[]> {
  const { results } = await db
    .prepare(
      `SELECT li.id AS id, li.title AS title, li.author AS author, li.updated_at AS updated_at
       FROM device_library_items dli
       JOIN library_items li ON li.id = dli.library_item_id
       WHERE dli.device_id = ? AND li.deleted_at IS NULL
       ORDER BY dli.position ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(deviceId, window.limit, window.offset)
    .all<RawOpdsItemRow>();
  return results.map(fromRow);
}

/**
 * Same scope as listAssignedLibraryItems, additionally filtered to rows
 * whose title, author, or source_url matches likePattern (plan §10.3's
 * WHERE clause, applied on top of the device-assignment scope rather than
 * account-wide — a device can only ever search within its own assigned
 * list). likePattern must already be built by
 * src/opds/search.ts's buildLikePattern (which escapes % and _); the
 * `ESCAPE '\'` clause here is what makes that escaping take effect.
 */
export async function searchAssignedLibraryItems(
  db: D1Database,
  deviceId: string,
  likePattern: string,
  window: FetchWindow,
): Promise<OpdsItemRow[]> {
  const { results } = await db
    .prepare(
      `SELECT li.id AS id, li.title AS title, li.author AS author, li.updated_at AS updated_at
       FROM device_library_items dli
       JOIN library_items li ON li.id = dli.library_item_id
       WHERE dli.device_id = ? AND li.deleted_at IS NULL
         AND (
           li.title LIKE ? ESCAPE '\\'
           OR li.author LIKE ? ESCAPE '\\'
           OR li.source_url LIKE ? ESCAPE '\\'
         )
       ORDER BY dli.position ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(deviceId, likePattern, likePattern, likePattern, window.limit, window.offset)
    .all<RawOpdsItemRow>();
  return results.map(fromRow);
}

export interface AssignedDownloadItem {
  id: string;
  title: string;
  r2Key: string;
}

/**
 * Resolves one item for GET /api/device/library-items/:itemId/download
 * (plan §10.4): only returns a row when itemId is currently assigned to
 * deviceId (device_library_items) and not soft-deleted — any other
 * combination (unassigned, assigned to a different device, deleted) yields
 * null, which the route maps to a 404 indistinguishable from "doesn't
 * exist" (plan §16 "他アカウントのXTCを取得できないようにする", extended to
 * "other device's XTC" the same way).
 */
export async function getAssignedLibraryItemForDownload(
  db: D1Database,
  deviceId: string,
  itemId: string,
): Promise<AssignedDownloadItem | null> {
  const row = await db
    .prepare(
      `SELECT li.id AS id, li.title AS title, li.r2_key AS r2_key
       FROM device_library_items dli
       JOIN library_items li ON li.id = dli.library_item_id
       WHERE dli.device_id = ? AND dli.library_item_id = ? AND li.deleted_at IS NULL`,
    )
    .bind(deviceId, itemId)
    .first<{ id: string; title: string; r2_key: string }>();
  return row === null ? null : { id: row.id, title: row.title, r2Key: row.r2_key };
}
