// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { countTotalAccounts } from "./auth/repository";
import {
  isPublicRegistrationClosedReason,
  resolveRegistrationClosedReason,
  resolveRegistrationMode,
} from "./auth/registration-mode";
import type { RegistrationClosedReason, RegistrationMode } from "./auth/registration-mode";
import { sumTotalLibraryBytes } from "./library/repository";
import {
  resolveMaxActiveSessionsPerAccount,
  resolveMaxDevicesPerAccount,
  resolveMaxLibraryBytesPerAccount,
  resolveMaxLibraryItemsPerAccount,
  resolveMaxPasskeysPerAccount,
  resolveMaxTotalAccounts,
  resolveMaxTotalLibraryBytes,
  resolveTermsVersion,
  resolveTotalStorageStopPercent,
} from "./quotas";
import type { Router } from "./router";
import type { Env } from "./types";

/**
 * GET /api/public/config (登録モード仕様 Phase2 §5, unauthenticated): the
 * minimum a not-yet-registered client needs to render (or hide) a
 * registration UI — current mode, whether registering is actually possible
 * right now, the terms version to display/accept, the per-account quota
 * defaults, and the Turnstile site key. Deliberately never returns
 * secrets, the raw account count, internal R2 layout, or the admin
 * storage-percent thresholds themselves (only the boolean result of
 * comparing against them) — see PHASE2_GAP_ANALYSIS.md §5.1 "返さないもの".
 */
export function registerPublicConfigRoute(router: Router): void {
  router.get("/api/public/config", async (_request, env) => {
    const mode = resolveRegistrationMode(env);
    const registrationAvailable = await isRegistrationAvailable(env, mode);
    const { registrationReason, registrationMessage } = resolveRegistrationClosureInfo(env, mode);
    return Response.json(
      {
        registrationMode: mode,
        registrationAvailable,
        registrationReason,
        registrationMessage,
        termsVersion: resolveTermsVersion(env),
        limits: {
          maxLibraryItemsPerAccount: resolveMaxLibraryItemsPerAccount(env),
          maxLibraryBytesPerAccount: resolveMaxLibraryBytesPerAccount(env),
          maxDevicesPerAccount: resolveMaxDevicesPerAccount(env),
          maxActiveSessionsPerAccount: resolveMaxActiveSessionsPerAccount(env),
          maxPasskeysPerAccount: resolveMaxPasskeysPerAccount(env),
        },
        turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
      },
      // Short cache: this changes rarely (a deploy, or crossing an
      // account/storage threshold) but a stampede of not-yet-registered
      // clients hitting this on every page load shouldn't each cost a D1
      // COUNT/SUM — same rationale as GET /api/books's cache header.
      { headers: { "Cache-Control": "public, max-age=30" } },
    );
  });
}

/**
 * mode !== "closed" AND the total-account cap isn't reached AND service-wide
 * storage is still under the "stop" threshold (登録モード仕様 Phase2 §4a/§4e).
 * A D1 COUNT + SUM per call; acceptable at this endpoint's expected volume
 * (see the Cache-Control header above).
 */
async function isRegistrationAvailable(env: Env, mode: RegistrationMode): Promise<boolean> {
  if (mode === "closed") {
    return false;
  }
  const [totalAccounts, totalLibraryBytes] = await Promise.all([
    countTotalAccounts(env.APP_DB),
    sumTotalLibraryBytes(env.APP_DB),
  ]);
  if (totalAccounts >= resolveMaxTotalAccounts(env)) {
    return false;
  }
  const stopBytes = (resolveMaxTotalLibraryBytes(env) * resolveTotalStorageStopPercent(env)) / 100;
  return totalLibraryBytes < stopBytes;
}

/**
 * 登録モード仕様 Phase3 §4: 公開可な理由(maintenance/capacity/manual)は
 * コード値＋対応する説明文言を返す。理由が非公開(security/abuse)、または
 * REGISTRATION_CLOSED_REASON が未設定/不明値のときは、コード値を一切
 * 露出せず（"security"/"abuse" という文字列自体も応答に出さない）汎用文言
 * のみを返す。mode!=="closed" のときは両フィールドとも null。
 *
 * message は英語の固定文（既存の ApiError message 群 — "new account
 * registration is closed" 等 — と同じ、API層は言語非依存という規約に
 * 揃えた）。実際にUIへ出す多言語文言はフロント側 i18n
 * (frontend/src/lib/i18n.svelte.ts) が registrationReason の値を見て
 * 組み立てる設計を推奨する（PHASE3_GAP_ANALYSIS.md §6 risk 4）— この
 * message フィールドはそれが無い場合のフォールバック/API単体利用者向け。
 */
const REGISTRATION_CLOSED_REASON_MESSAGES: Partial<Record<RegistrationClosedReason, string>> = {
  maintenance: "Registration is temporarily closed for maintenance.",
  capacity: "Registration is temporarily closed because capacity limits have been reached.",
  manual: "Registration is currently closed.",
};

/** Never mentions "security" or "abuse" — used whenever the reason is unset or not one of the 3 public values. */
const GENERIC_REGISTRATION_CLOSED_MESSAGE = "New registration is currently paused.";

function resolveRegistrationClosureInfo(
  env: Pick<Env, "REGISTRATION_CLOSED_REASON">,
  mode: RegistrationMode,
): { registrationReason: string | null; registrationMessage: string | null } {
  if (mode !== "closed") {
    return { registrationReason: null, registrationMessage: null };
  }
  const reason = resolveRegistrationClosedReason(env);
  if (reason !== null && isPublicRegistrationClosedReason(reason)) {
    return { registrationReason: reason, registrationMessage: REGISTRATION_CLOSED_REASON_MESSAGES[reason] ?? null };
  }
  return { registrationReason: null, registrationMessage: GENERIC_REGISTRATION_CLOSED_MESSAGE };
}
