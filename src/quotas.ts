// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "./types";

/**
 * 登録モード仕様 Phase 1 §5.3 のアカウント単位クォータ既定値と、その
 * env（文字列）からの解決関数群。env は wrangler.jsonc の vars として文字列
 * で入る点に注意 — parseInt + NaN フォールバックで、未設定/不正値は常に
 * 既定値へフォールバックする（resolveSessionTtlDays と同じ方針、
 * src/auth/sessions.ts）。値を無効化する手段はない（0や負値も既定値扱い）。
 */

const DEFAULT_MAX_LIBRARY_ITEMS_PER_ACCOUNT = 100;
const DEFAULT_MAX_LIBRARY_BYTES_PER_ACCOUNT = 1_073_741_824; // 1 GiB
const DEFAULT_MAX_DEVICES_PER_ACCOUNT = 5;
const DEFAULT_MAX_ACTIVE_SESSIONS_PER_ACCOUNT = 10;
const DEFAULT_MAX_PASSKEYS_PER_ACCOUNT = 5;

function resolvePositiveInt(value: string | undefined, fallback: number): number {
  const configured = Number.parseInt(value ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export function resolveMaxLibraryItemsPerAccount(
  env: Pick<Env, "MAX_LIBRARY_ITEMS_PER_ACCOUNT">,
): number {
  return resolvePositiveInt(env.MAX_LIBRARY_ITEMS_PER_ACCOUNT, DEFAULT_MAX_LIBRARY_ITEMS_PER_ACCOUNT);
}

export function resolveMaxLibraryBytesPerAccount(
  env: Pick<Env, "MAX_LIBRARY_BYTES_PER_ACCOUNT">,
): number {
  return resolvePositiveInt(env.MAX_LIBRARY_BYTES_PER_ACCOUNT, DEFAULT_MAX_LIBRARY_BYTES_PER_ACCOUNT);
}

export function resolveMaxDevicesPerAccount(env: Pick<Env, "MAX_DEVICES_PER_ACCOUNT">): number {
  return resolvePositiveInt(env.MAX_DEVICES_PER_ACCOUNT, DEFAULT_MAX_DEVICES_PER_ACCOUNT);
}

export function resolveMaxActiveSessionsPerAccount(
  env: Pick<Env, "MAX_ACTIVE_SESSIONS_PER_ACCOUNT">,
): number {
  return resolvePositiveInt(env.MAX_ACTIVE_SESSIONS_PER_ACCOUNT, DEFAULT_MAX_ACTIVE_SESSIONS_PER_ACCOUNT);
}

export function resolveMaxPasskeysPerAccount(env: Pick<Env, "MAX_PASSKEYS_PER_ACCOUNT">): number {
  return resolvePositiveInt(env.MAX_PASSKEYS_PER_ACCOUNT, DEFAULT_MAX_PASSKEYS_PER_ACCOUNT);
}
