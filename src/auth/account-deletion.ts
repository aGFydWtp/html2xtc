// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { listDevicesForAccount, revokeDeviceRow } from "../devices/repository";
import { recordOrphanedR2Object } from "../db/orphaned-r2";
import { listLibraryItems } from "../library/repository";
import type { Env } from "../types";
import { deleteAccountById } from "./repository";
import type { Account } from "./sessions";

/**
 * DELETE /api/me/account orchestration (登録モード仕様 Phase1 §5.5):
 *  1. list the account's library R2 keys and active devices
 *  2. revoke every device (soft — the accounts row itself is about to be
 *     hard-deleted below, but revoking first means a device mid-poll sees
 *     "revoked" immediately rather than racing the cascade)
 *  3. best-effort delete each R2 object; a failure is recorded in
 *     orphaned_r2_objects (src/db/orphaned-r2.ts) rather than aborting —
 *     the D1 deletion below must always complete regardless of R2 outcome
 *  4. DELETE the accounts row; ON DELETE CASCADE
 *     (migrations/app/0001_initial.sql) removes webauthn_credentials,
 *     sessions, library_items, and devices in the same statement
 *
 * Caller (src/auth/routes.ts) is responsible for the confirmation check,
 * CSRF/session/rate-limit gates, Cookie expiry, and the account.deleted
 * audit log — this module only does the deletion itself, mirroring how
 * src/library/service.ts stays free of HTTP concerns.
 */
export async function deleteAccountCompletely(
  env: Pick<Env, "APP_DB" | "XTC_BUCKET">,
  account: Account,
): Promise<void> {
  const items = await listLibraryItems(env.APP_DB, account.id);
  const devices = await listDevicesForAccount(env.APP_DB, account.id);
  const revokedAt = new Date().toISOString();
  for (const device of devices) {
    await revokeDeviceRow(env.APP_DB, account.id, device.id, revokedAt);
  }
  for (const item of items) {
    try {
      await env.XTC_BUCKET.delete(item.r2Key);
    } catch (error) {
      console.error(`R2 delete of ${item.r2Key} failed during account deletion`, error);
      await recordOrphanedR2Object(env, item.r2Key, "account_deletion_r2_delete_failed");
    }
  }
  await deleteAccountById(env.APP_DB, account.id);
}
