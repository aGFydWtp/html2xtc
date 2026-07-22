// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { countTotalAccounts } from "./auth/repository";
import { resolveRegistrationMode } from "./auth/registration-mode";
import type { RegistrationMode } from "./auth/registration-mode";
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
    return Response.json(
      {
        registrationMode: mode,
        registrationAvailable,
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
