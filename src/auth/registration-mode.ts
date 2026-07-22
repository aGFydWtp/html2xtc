// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "../types";

/**
 * 登録モード仕様 Phase 1 (§5.1): "invite" (招待制、既定) / "open" (招待なし
 * 登録を許可) / "closed" (新規登録停止)。Phase 1では "open" の実処理は未実装
 * — 招待なし登録を許可するのは Phase 2 の担当（src/auth/webauthn.ts の
 * startRegistration 参照）。resolveRegistrationMode 自体は3値すべてを解決
 * できるので、Phase 2はこの関数を変更せず分岐先を追加するだけで済む。
 */
export type RegistrationMode = "invite" | "open" | "closed";

const DEFAULT_REGISTRATION_MODE: RegistrationMode = "invite";

/**
 * REGISTRATION_MODE を解決する。不正値・未設定は安全側の既定 "invite" に
 * フォールバックする — resolveSessionTtlDays (src/auth/sessions.ts) と同じ
 * フォールバック方針。既存デプロイ（wrangler.jsonc 未更新環境）でも動作が
 * 変わらないことを保証する。
 */
export function resolveRegistrationMode(env: Pick<Env, "REGISTRATION_MODE">): RegistrationMode {
  const value = env.REGISTRATION_MODE;
  return value === "invite" || value === "open" || value === "closed" ? value : DEFAULT_REGISTRATION_MODE;
}

/**
 * 登録モード仕様 Phase 3 §4: mode==="closed" のとき、なぜ閉じているかの理由。
 * 公開可(maintenance/capacity/manual) と非公開(security/abuse) の2群に分かれる
 * — 非公開理由はコード値自体をクライアントに一切露出してはならない
 * (GET /api/public/config 側の出し分けは src/public-config.ts が担う。
 * このモジュールは「値の解決」と「公開可否の判定」のみを持つ)。
 */
export type RegistrationClosedReason = "maintenance" | "capacity" | "manual" | "security" | "abuse";

const REGISTRATION_CLOSED_REASONS: ReadonlySet<string> = new Set([
  "maintenance",
  "capacity",
  "manual",
  "security",
  "abuse",
]);

/** Reasons safe to expose (code + message) to an unauthenticated client. */
const PUBLIC_REGISTRATION_CLOSED_REASONS: ReadonlySet<RegistrationClosedReason> = new Set([
  "maintenance",
  "capacity",
  "manual",
]);

/**
 * Resolves REGISTRATION_CLOSED_REASON. Unset or any value outside the known
 * 5 is treated as "no reason" (null) — same safe-fallback shape as
 * resolveRegistrationMode above. A null result is never itself a leak: the
 * caller (src/public-config.ts) falls back to a generic "paused" message
 * whether the reason is null, unset, or a recognized-but-non-public value.
 */
export function resolveRegistrationClosedReason(
  env: Pick<Env, "REGISTRATION_CLOSED_REASON">,
): RegistrationClosedReason | null {
  const value = env.REGISTRATION_CLOSED_REASON;
  return value !== undefined && REGISTRATION_CLOSED_REASONS.has(value) ? (value as RegistrationClosedReason) : null;
}

/** True for maintenance/capacity/manual — the reasons GET /api/public/config may name directly. */
export function isPublicRegistrationClosedReason(reason: RegistrationClosedReason): boolean {
  return PUBLIC_REGISTRATION_CLOSED_REASONS.has(reason);
}
