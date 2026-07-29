// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { genericAdapter } from "./generic";
import type { OpdsProviderAdapter } from "../types";

/**
 * Memlane provider adapter (spec §6/§7). The real-service investigation
 * (2026-07-29, run against a developer-owned Memlane OPDS connection — see
 * the task's investigation notes; no real URL/secret is recorded here or
 * anywhere else in this codebase) found:
 *   - single origin, zero redirects for both feed and EPUB acquisition
 *     responses
 *   - feed Content-Type "application/atom+xml;profile=opds-catalog;
 *     kind=navigation|acquisition" — recognized fine by genericAdapter's
 *     loose "contains xml" check
 *   - EPUB acquisition responses: Content-Type application/epub+zip,
 *     Content-Length present, same-origin, no CDN host
 * i.e. no deviation from a well-behaved single-origin OPDS server that
 * genericAdapter doesn't already handle correctly. Kept as its own module
 * (rather than importing genericAdapter directly at every call site) so a
 * future real Memlane-specific quirk gets a one-line change here instead of
 * an `if (provider === "memlane")` branch spreading through service.ts.
 */
export const memlaneAdapter: OpdsProviderAdapter = genericAdapter;
