// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "../types";

/**
 * 登録モード仕様 Phase 1 §5.5: アカウント削除時、R2削除が失敗してもD1削除は
 * 完遂させる（plan の既存 deleteLibrary の「D1行を残す」方式は、アカウント
 * 削除では使えない — D1削除完了が要件のため）。代わりに孤児キーを
 * orphaned_r2_objects（migrations/app/0003_orphaned_r2_objects.sql）に記録
 * する。Phase 1では書き込みのみ；再削除バッチは後続フェーズで
 * src/db/cleanup.ts に追加する。
 */
export async function recordOrphanedR2Object(
  env: Pick<Env, "APP_DB">,
  r2Key: string,
  reason: string,
): Promise<void> {
  try {
    await env.APP_DB.prepare(
      `INSERT INTO orphaned_r2_objects (id, r2_key, reason, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), r2Key, reason, new Date().toISOString())
      .run();
  } catch (error) {
    // Best-effort: a failure to even record the orphan must never block the
    // account deletion that's already in progress (same stance as
    // src/library/storage.ts's deleteLibraryStorageBestEffort).
    console.error(`failed to record orphaned R2 object ${r2Key}`, error);
  }
}
