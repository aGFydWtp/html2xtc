// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Account } from "../auth/sessions";
import { bumpLibraryVersionForDevices } from "../devices/repository";
import { resolveLibraryWriteMode } from "../feature-flags";
import { outputXtcKey } from "../jobs";
import { resolveMaxLibraryBytesPerAccount, resolveMaxLibraryItemsPerAccount } from "../quotas";
import { logAuditEvent } from "../security/audit";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import {
  countActiveLibraryItems,
  findLibraryItemByJobId,
  getLibraryItem,
  hardDeleteLibraryItem,
  insertLibraryItem,
  listLibraryItems,
  removeItemFromAllDeviceLibraries,
  softDeleteLibraryItem,
  sumLibraryBytes,
  updateLibraryItem,
} from "./repository";
import type { LibraryItem } from "./repository";
import { copyToLibraryStorage, deleteLibraryStorageBestEffort } from "./storage";

/**
 * Service layer for the Phase 1 library API (plan §8.2 / §9.2): validates
 * input, orchestrates the R2 copy + D1 registration for from-job saves, and
 * enforces the account_id scoping that keeps one account's items invisible
 * to every other account. src/library/routes.ts is the thin HTTP adapter
 * over this module.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates a jobId — same UUID shape as UUID_PATTERN in src/index.ts (jobIds are crypto.randomUUID()). */
export function isValidJobId(jobId: string): boolean {
  return UUID_PATTERN.test(jobId);
}

/** Validates an itemId — library itemIds are also crypto.randomUUID() (see saveJobToLibrary). */
export function isValidItemId(itemId: string): boolean {
  return UUID_PATTERN.test(itemId);
}

const MAX_TITLE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 200;

/** Strips control characters, trims, and caps length for title/author free text. */
function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export interface FromJobRequest {
  jobId: string;
  title?: string;
  author?: string;
}

/** Public shape returned to the client — no r2Key, no internal IDs beyond the item's own. */
export interface LibraryItemDto {
  id: string;
  title: string;
  author: string | null;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(item: LibraryItem): LibraryItemDto {
  return {
    id: item.id,
    title: item.title,
    author: item.author,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Implements POST /api/library/items/from-job (plan §8.2):
 *  1. validate jobId
 *  2. return the existing item idempotently if this job was already saved
 *  3. stream jobs/{jobId}/output.xtc into library/accounts/{accountId}/...
 *  4. register the D1 row
 * Rolls the R2 copy back best-effort if the D1 insert fails, and if that
 * failure was actually a concurrent duplicate save, returns the other
 * request's result instead of an error.
 *
 * Quota checks (登録モード仕様 Phase1 §5.3): the item-count quota is checked
 * before the R2 copy (cheap to reject early); the byte quota can only be
 * checked *after* the copy (the real size is only known once copied), so a
 * quota-exceeding copy is rolled back via deleteLibraryStorageBestEffort
 * before returning 413 — mirroring the existing D1-insert-failure rollback
 * path below.
 */
export async function saveJobToLibrary(
  env: Pick<
    Env,
    "APP_DB" | "XTC_BUCKET" | "MAX_LIBRARY_ITEMS_PER_ACCOUNT" | "MAX_LIBRARY_BYTES_PER_ACCOUNT" | "LIBRARY_WRITE_MODE"
  >,
  account: Account,
  request: FromJobRequest,
): Promise<LibraryItemDto> {
  // 登録モード仕様 Phase3 §7: LIBRARY_WRITE_MODE==="read-only" のときだけ
  // 新規保存を止める。閲覧(listLibrary)・更新(updateLibrary)・削除
  // (deleteLibrary)・ダウンロード(getLibraryDownload)は対象外 — このガード
  // はこの関数にしか無い。
  if (resolveLibraryWriteMode(env) === "read-only") {
    throw Errors.forbidden("LIBRARY_READ_ONLY", "saving new library items is currently disabled");
  }
  if (!isValidJobId(request.jobId)) {
    throw Errors.badRequest("INVALID_JOB_ID", "jobId must be a UUID");
  }

  const existing = await findLibraryItemByJobId(env.APP_DB, account.id, request.jobId);
  if (existing !== null) {
    return toDto(existing);
  }

  const itemCount = await countActiveLibraryItems(env.APP_DB, account.id);
  if (itemCount >= resolveMaxLibraryItemsPerAccount(env)) {
    logAuditEvent("account.quota.exceeded", { accountId: account.id, quota: "library_items" });
    throw Errors.conflict("LIBRARY_ITEM_LIMIT_EXCEEDED", "library item limit reached");
  }

  const sourceKey = outputXtcKey(request.jobId);
  const itemId = crypto.randomUUID();
  const copied = await copyToLibraryStorage(env, sourceKey, account.id, itemId);
  if (copied === null) {
    throw Errors.notFound("JOB_OUTPUT_NOT_FOUND", "job output not found");
  }

  const existingBytes = await sumLibraryBytes(env.APP_DB, account.id);
  if (existingBytes + copied.sizeBytes > resolveMaxLibraryBytesPerAccount(env)) {
    await deleteLibraryStorageBestEffort(env, copied.key);
    logAuditEvent("account.quota.exceeded", { accountId: account.id, quota: "library_bytes" });
    throw Errors.payloadTooLarge("LIBRARY_STORAGE_LIMIT_EXCEEDED", "library storage limit reached");
  }

  const requestedTitle = request.title !== undefined ? sanitizeText(request.title, MAX_TITLE_LENGTH) : "";
  const fallbackTitle = copied.title !== null ? sanitizeText(copied.title, MAX_TITLE_LENGTH) : "";
  const title = requestedTitle.length > 0 ? requestedTitle : fallbackTitle.length > 0 ? fallbackTitle : request.jobId;

  const requestedAuthor = request.author !== undefined ? sanitizeText(request.author, MAX_AUTHOR_LENGTH) : "";
  const author = requestedAuthor.length > 0 ? requestedAuthor : null;

  const nowIso = new Date().toISOString();
  try {
    await insertLibraryItem(env.APP_DB, {
      id: itemId,
      accountId: account.id,
      sourceJobId: request.jobId,
      sourceUrl: null,
      title,
      author,
      r2Key: copied.key,
      sizeBytes: copied.sizeBytes,
      sha256: copied.sha256,
      createdAt: nowIso,
    });
  } catch (error) {
    console.error(`library item insert failed for job ${request.jobId}`, error);
    await deleteLibraryStorageBestEffort(env, copied.key);
    // A concurrent request may have inserted its own row for the same job in
    // between the idempotency check above and this insert; if so, surface
    // its result rather than an error the client didn't cause.
    const raced = await findLibraryItemByJobId(env.APP_DB, account.id, request.jobId);
    if (raced !== null) {
      return toDto(raced);
    }
    throw Errors.internal("failed to save library item");
  }

  const created = await getLibraryItem(env.APP_DB, account.id, itemId);
  if (created === null) {
    throw Errors.internal("failed to save library item");
  }
  return toDto(created);
}

/** GET /api/library/items — deleted_at IS NULL only, created_at DESC (plan §9.2). */
export async function listLibrary(
  env: Pick<Env, "APP_DB">,
  account: Account,
): Promise<LibraryItemDto[]> {
  const items = await listLibraryItems(env.APP_DB, account.id);
  return items.map(toDto);
}

export interface UpdateLibraryItemRequest {
  title?: string;
  author?: string | null;
}

/** PATCH /api/library/items/:itemId — title and/or author. */
export async function updateLibrary(
  env: Pick<Env, "APP_DB">,
  account: Account,
  itemId: string,
  patch: UpdateLibraryItemRequest,
): Promise<LibraryItemDto> {
  if (!isValidItemId(itemId)) {
    throw Errors.badRequest("INVALID_ITEM_ID", "itemId must be a UUID");
  }

  const normalizedPatch: { title?: string; author?: string | null } = {};
  if (patch.title !== undefined) {
    const title = sanitizeText(patch.title, MAX_TITLE_LENGTH);
    if (title.length === 0) {
      throw Errors.badRequest("INVALID_TITLE", "title must not be empty");
    }
    normalizedPatch.title = title;
  }
  if (patch.author !== undefined) {
    normalizedPatch.author = patch.author === null ? null : sanitizeText(patch.author, MAX_AUTHOR_LENGTH);
  }

  const updatedAt = new Date().toISOString();
  const changed = await updateLibraryItem(env.APP_DB, account.id, itemId, normalizedPatch, updatedAt);
  if (!changed) {
    throw Errors.notFound("ITEM_NOT_FOUND", "library item not found");
  }
  const item = await getLibraryItem(env.APP_DB, account.id, itemId);
  if (item === null) {
    throw Errors.notFound("ITEM_NOT_FOUND", "library item not found");
  }
  return toDto(item);
}

/**
 * DELETE /api/library/items/:itemId (plan §9.2): marks the item deleted,
 * detaches it from every device's list, then attempts the R2 delete — the
 * D1 row is only physically removed once the object is confirmed gone, so a
 * failed R2 delete leaves a deleted_at-marked row behind (picked up by a
 * Phase 7 cleanup job) instead of an orphaned object with no record of it.
 */
export async function deleteLibrary(
  env: Pick<Env, "APP_DB" | "XTC_BUCKET">,
  account: Account,
  itemId: string,
): Promise<void> {
  if (!isValidItemId(itemId)) {
    throw Errors.badRequest("INVALID_ITEM_ID", "itemId must be a UUID");
  }

  const item = await getLibraryItem(env.APP_DB, account.id, itemId);
  if (item === null) {
    throw Errors.notFound("ITEM_NOT_FOUND", "library item not found");
  }

  const deletedAt = new Date().toISOString();
  const marked = await softDeleteLibraryItem(env.APP_DB, account.id, itemId, deletedAt);
  if (!marked) {
    throw Errors.notFound("ITEM_NOT_FOUND", "library item not found");
  }
  const affectedDeviceIds = await removeItemFromAllDeviceLibraries(env.APP_DB, itemId);
  await bumpLibraryVersionForDevices(env.APP_DB, affectedDeviceIds, deletedAt);

  try {
    await env.XTC_BUCKET.delete(item.r2Key);
    await hardDeleteLibraryItem(env.APP_DB, itemId);
  } catch (error) {
    console.error(`R2 delete of ${item.r2Key} failed for item ${itemId}`, error);
  }
}

/** GET /api/library/items/:itemId/download — resolves the R2 object + owning item, or null if not found/not owned. */
export async function getLibraryDownload(
  env: Pick<Env, "APP_DB" | "XTC_BUCKET">,
  account: Account,
  itemId: string,
): Promise<{ object: R2ObjectBody; item: LibraryItem } | null> {
  if (!isValidItemId(itemId)) {
    return null;
  }
  const item = await getLibraryItem(env.APP_DB, account.id, itemId);
  if (item === null) {
    return null;
  }
  const object = await env.XTC_BUCKET.get(item.r2Key);
  if (object === null) {
    return null;
  }
  return { object, item };
}
