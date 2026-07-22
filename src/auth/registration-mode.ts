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
