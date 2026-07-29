// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { Errors } from "../../../security/errors";
import type { DecryptedOpdsConnection, OpdsProviderAdapter, ParsedOpdsEntry } from "../types";

/**
 * Default provider adapter (spec §6): no vendor-specific behavior at all.
 * Every provider not overridden with its own adapter (providers/index.ts's
 * resolveProviderAdapter) uses this — including memlaneAdapter today (spec
 * §6/§7: the Memlane investigation found no CDN/redirect/Content-Type
 * deviation from a well-behaved single-origin OPDS server, so it's a plain
 * alias rather than its own object with identical bodies).
 */
export const genericAdapter: OpdsProviderAdapter = {
  normalizeConnectionInput<T>(input: T): T {
    return input;
  },

  async validateCatalogResponse(response: Response): Promise<void> {
    const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
    // Loose on purpose: real OPDS servers vary
    // ("application/atom+xml;profile=opds-catalog;kind=navigation",
    // "application/atom+xml", occasionally a bare "text/xml"). This only
    // rejects the clearly-wrong case of a non-XML response — e.g. an HTML
    // login/error page a misconfigured or unreachable server serves
    // instead of a feed.
    if (!contentType.includes("xml")) {
      throw Errors.unprocessable("OPDS_FEED_INVALID", "unexpected feed Content-Type");
    }
  },

  isAllowedNavigationUrl(connection: DecryptedOpdsConnection, target: URL): boolean {
    // spec §15 "navigation/searchは原則同一origin" — no CDN allowlist for
    // the generic adapter; a provider that legitimately needs one gets its
    // own adapter (spec §6/§15 point 16).
    return target.origin === connection.origin;
  },

  isAllowedAcquisitionUrl(connection: DecryptedOpdsConnection, target: URL): boolean {
    // spec §15 "acquisitionは同一originを原則" — same stance as navigation.
    return target.origin === connection.origin;
  },

  normalizeEntry(entry: ParsedOpdsEntry): ParsedOpdsEntry {
    return entry;
  },
};
