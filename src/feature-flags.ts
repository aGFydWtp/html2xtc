// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "./types";

/**
 * 登録モード仕様 Phase 3 §7 の機能フラグ3種の env 解決関数。いずれも
 * resolveRegistrationMode (src/auth/registration-mode.ts) と同じフォール
 * バック方針: 未設定・不正値は常に許可側(=現行動作)へフォールバックする。
 * 本番の wrangler.jsonc がこれらのキーを一切設定しなくても、この resolver
 * 群は既定側の値を返すので既存動作は変わらない。
 */

// --- LIBRARY_WRITE_MODE: "read-write" (既定) | "read-only" -----------------

export type LibraryWriteMode = "read-write" | "read-only";

const DEFAULT_LIBRARY_WRITE_MODE: LibraryWriteMode = "read-write";

/** "read-only" のときだけ新規ライブラリ保存(saveJobToLibrary)を止める。閲覧・更新・削除・ダウンロードは対象外。 */
export function resolveLibraryWriteMode(env: Pick<Env, "LIBRARY_WRITE_MODE">): LibraryWriteMode {
  return env.LIBRARY_WRITE_MODE === "read-only" ? "read-only" : DEFAULT_LIBRARY_WRITE_MODE;
}

// --- PAIRING_MODE: "enabled" (既定) | "disabled" ----------------------------

export type PairingMode = "enabled" | "disabled";

const DEFAULT_PAIRING_MODE: PairingMode = "enabled";

/** "disabled" のときだけ新規端末ペアリング開始(startPairing)を止める。既存端末の利用・OPDS・解除・進行中ペアリングの完了/承認/拒否は対象外。 */
export function resolvePairingMode(env: Pick<Env, "PAIRING_MODE">): PairingMode {
  return env.PAIRING_MODE === "disabled" ? "disabled" : DEFAULT_PAIRING_MODE;
}

// --- CONVERSION_MODE: "enabled" (既定) | "disabled" -------------------------

export type ConversionMode = "enabled" | "disabled";

const DEFAULT_CONVERSION_MODE: ConversionMode = "enabled";

/** "disabled" のときだけ新規変換の開始(/convert, /jobs, /jobs/pdf, /jobs/text)を止める。ジョブ状態参照・ダウンロードは対象外。 */
export function resolveConversionMode(env: Pick<Env, "CONVERSION_MODE">): ConversionMode {
  return env.CONVERSION_MODE === "disabled" ? "disabled" : DEFAULT_CONVERSION_MODE;
}
