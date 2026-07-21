// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Pure helper for the OPDS search feed (plan §10.3): turns a raw user query
 * into a SQL LIKE pattern, escaping LIKE's own wildcard characters (% and _)
 * so a search term containing them is matched literally rather than as a
 * wildcard. Kept free of D1 imports so the escaping is directly
 * unit-testable (see test/opds-search.test.ts); src/opds/repository.ts pairs
 * this with `ESCAPE '\'` in the SQL itself.
 */

/**
 * Builds a `%...%` substring-match LIKE pattern from a raw query, escaping
 * backslash (the escape character itself, so it must be escaped first),
 * then % and _. The caller's SQL must use `ESCAPE '\'` for this escaping to
 * take effect.
 */
export function buildLikePattern(query: string): string {
  const escaped = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `%${escaped}%`;
}
