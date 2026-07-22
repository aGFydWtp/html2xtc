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

/**
 * 登録モード仕様 Phase 2 (§4a/§4b/§4e) のサービス全体クォータ既定値。
 * アカウント単位クォータ（上記）と同じ resolvePositiveInt フォールバック
 * パターン — 未設定/不正値は既定値、値を無効化する手段はない。
 */

const DEFAULT_MAX_TOTAL_ACCOUNTS = 500;
const DEFAULT_MAX_NEW_ACCOUNTS_PER_DAY = 50;
const DEFAULT_MAX_NEW_ACCOUNTS_PER_IP_PER_DAY = 3;
const DEFAULT_MAX_TOTAL_LIBRARY_BYTES = 53_687_091_200; // 50 GiB
const DEFAULT_TOTAL_STORAGE_WARNING_PERCENT = 80;
const DEFAULT_TOTAL_STORAGE_STOP_PERCENT = 95;

export function resolveMaxTotalAccounts(env: Pick<Env, "MAX_TOTAL_ACCOUNTS">): number {
  return resolvePositiveInt(env.MAX_TOTAL_ACCOUNTS, DEFAULT_MAX_TOTAL_ACCOUNTS);
}

export function resolveMaxNewAccountsPerDay(env: Pick<Env, "MAX_NEW_ACCOUNTS_PER_DAY">): number {
  return resolvePositiveInt(env.MAX_NEW_ACCOUNTS_PER_DAY, DEFAULT_MAX_NEW_ACCOUNTS_PER_DAY);
}

export function resolveMaxNewAccountsPerIpPerDay(
  env: Pick<Env, "MAX_NEW_ACCOUNTS_PER_IP_PER_DAY">,
): number {
  return resolvePositiveInt(env.MAX_NEW_ACCOUNTS_PER_IP_PER_DAY, DEFAULT_MAX_NEW_ACCOUNTS_PER_IP_PER_DAY);
}

export function resolveMaxTotalLibraryBytes(env: Pick<Env, "MAX_TOTAL_LIBRARY_BYTES">): number {
  return resolvePositiveInt(env.MAX_TOTAL_LIBRARY_BYTES, DEFAULT_MAX_TOTAL_LIBRARY_BYTES);
}

/** Percent resolver: unlike resolvePositiveInt, 0 is a legitimate configured value (not "unset"), and anything outside [0,100] falls back to the default. */
function resolvePercent(value: string | undefined, fallback: number): number {
  const configured = Number.parseInt(value ?? "", 10);
  return Number.isFinite(configured) && configured >= 0 && configured <= 100 ? configured : fallback;
}

export function resolveTotalStorageWarningPercent(
  env: Pick<Env, "TOTAL_STORAGE_WARNING_PERCENT">,
): number {
  return resolvePercent(env.TOTAL_STORAGE_WARNING_PERCENT, DEFAULT_TOTAL_STORAGE_WARNING_PERCENT);
}

export function resolveTotalStorageStopPercent(env: Pick<Env, "TOTAL_STORAGE_STOP_PERCENT">): number {
  return resolvePercent(env.TOTAL_STORAGE_STOP_PERCENT, DEFAULT_TOTAL_STORAGE_STOP_PERCENT);
}

/**
 * Terms/privacy version string (Phase2 §3d/§4c/§11). Unlike every other
 * resolver above, an unset TERMS_VERSION has no safe numeric fallback —
 * returning null lets callers (GET /api/public/config, the open
 * registration/options handler) fail closed instead of silently recording
 * an empty-string terms_version that no real terms document matches.
 */
export function resolveTermsVersion(env: Pick<Env, "TERMS_VERSION">): string | null {
  return env.TERMS_VERSION !== undefined && env.TERMS_VERSION.length > 0 ? env.TERMS_VERSION : null;
}
