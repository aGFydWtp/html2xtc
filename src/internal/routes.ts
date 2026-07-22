// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { countAccountsCreatedSince, countTotalAccounts } from "../auth/repository";
import { sumTotalLibraryBytes } from "../library/repository";
import { resolveMaxNewAccountsPerDay, resolveMaxTotalAccounts, resolveMaxTotalLibraryBytes } from "../quotas";
import type { Router } from "../router";
import { timingSafeEqual } from "../security/crypto";
import { Errors } from "../security/errors";

const INTERNAL_STATUS_HEADER = "X-Internal-Status-Secret";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /internal/registration/status (登録モード仕様 Phase2 §10): a
 * capacity/health snapshot for ops dashboards, never exposed to end users.
 *
 * Cloudflare Access should also front every /internal/* path in the
 * dashboard/Terraform config — that's outside this repository's scope (no
 * prior art for it in this codebase; see PHASE2_GAP_ANALYSIS.md §5.1/§6).
 * The shared-secret header check below is defense-in-depth on the Worker
 * side only, fail-closed: an unset INTERNAL_STATUS_SECRET or a
 * missing/non-matching header is always 401, never "open by default".
 */
export function registerInternalRoutes(router: Router): void {
  router.get("/internal/registration/status", async (request, env) => {
    const provided = request.headers.get(INTERNAL_STATUS_HEADER);
    const expected = env.INTERNAL_STATUS_SECRET;
    if (
      expected === undefined ||
      expected.length === 0 ||
      provided === null ||
      !timingSafeEqual(provided, expected)
    ) {
      throw Errors.unauthorized("internal status endpoint requires a valid shared secret");
    }

    const dailyCutoff = new Date(Date.now() - DAY_MS).toISOString();
    const [accountCount, accountsCreatedToday, libraryBytes] = await Promise.all([
      countTotalAccounts(env.APP_DB),
      countAccountsCreatedSince(env.APP_DB, dailyCutoff),
      sumTotalLibraryBytes(env.APP_DB),
    ]);

    return Response.json({
      accountCount,
      maxAccounts: resolveMaxTotalAccounts(env),
      accountsCreatedToday,
      maxNewAccountsPerDay: resolveMaxNewAccountsPerDay(env),
      libraryBytes,
      maxTotalLibraryBytes: resolveMaxTotalLibraryBytes(env),
    });
  });
}
