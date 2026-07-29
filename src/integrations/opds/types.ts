// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Shared types for the generic OPDS integration (汎用OPDS基盤＋Memlane EPUB
 * 取り込み機能 実装仕様書 §5/§6/§9.1). Deliberately its own tree
 * (src/integrations/opds/) distinct from src/opds/ — the latter is this
 * codebase's EXISTING "serve html2xtc's own library as an OPDS feed to the
 * Xteink device" feature (src/opds/routes.ts's registerOpdsRoutes); this one
 * is the new "pull EPUBs in from an external OPDS server" feature. Sharing a
 * directory or an export name between the two would be a confusing
 * namespace collision (spec §28) — hence `registerOpdsIntegrationRoutes`,
 * not `registerOpdsRoutes`, in routes.ts.
 */

/** Spec §5.2. */
export type OpdsAuthType = "none" | "url_secret" | "basic";

export function isOpdsAuthType(value: unknown): value is OpdsAuthType {
  return value === "none" || value === "url_secret" || value === "basic";
}

/** Spec §6. */
export type OpdsProvider = "memlane" | "generic" | "calibre" | "calibre_web" | "kavita" | "other";

export function isOpdsProvider(value: unknown): value is OpdsProvider {
  return (
    value === "memlane" ||
    value === "generic" ||
    value === "calibre" ||
    value === "calibre_web" ||
    value === "kavita" ||
    value === "other"
  );
}

/** Public summary shape (GET /api/integrations/opds, spec §13.1) — never carries a secret. */
export interface OpdsConnectionSummary {
  id: string;
  name: string;
  provider: OpdsProvider;
  authType: OpdsAuthType;
  host: string;
  lastVerifiedAt: string | null;
}

/**
 * A connection with its credential fields decrypted, held only in memory for
 * the duration of one request (never persisted, never logged, never
 * returned to a client) — the shape src/integrations/opds/fetch.ts and the
 * provider adapters (spec §6's OpdsProviderAdapter) operate on.
 */
export interface DecryptedOpdsConnection {
  id: string;
  accountId: string;
  provider: OpdsProvider;
  authType: OpdsAuthType;
  /** The account's original catalog URL, e.g. for authType="url_secret" this itself is the bearer credential. */
  catalogUrl: string;
  /** Parsed origin of catalogUrl ("https://example.com") — same-origin checks use this, never a re-parse of the secret URL string where avoidable. */
  origin: string;
  /** Hostname only ("example.com") — the one piece of the URL this codebase is allowed to surface (API responses, audit events). */
  host: string;
  username: string | null;
  password: string | null;
}

/** One <link> parsed out of an OPDS/Atom feed (src/integrations/opds/parser-v1.ts). Never exposed to a client as-is — only ever used server-side to build an encrypted cursor. */
export interface ParsedOpdsLink {
  rel: string;
  type: string | null;
  /** Absolute URL (resolved against the feed's own URL) — a relative href never leaves the parser. */
  href: string;
}

export type ParsedOpdsEntryKind = "navigation" | "publication";

export interface ParsedOpdsEntry {
  kind: ParsedOpdsEntryKind;
  /** The feed's own <id> text — never returned to a client verbatim (see opaqueEntryId in service.ts). */
  sourceId: string;
  title: string;
  author: string | null;
  updated: string | null;
  /** Present only for kind:"navigation" — the absolute URL of the rel="subsection" link. */
  navigationHref?: string;
  /** Present only for kind:"publication" when an EPUB acquisition link was recognized. */
  acquisitionHref?: string;
}

export interface ParsedOpdsFeed {
  title: string;
  entries: ParsedOpdsEntry[];
  nextHref: string | null;
  previousHref: string | null;
  /** Absolute URL of the OpenSearch *description document* (rel="search") — not yet a search template; src/integrations/opds/search.ts fetches and parses that document separately. */
  searchHref: string | null;
}

/**
 * Provider adapter interface (spec §6). `memlaneAdapter` starts out as a
 * plain alias of `genericAdapter` (spec §6/§7's Memlane investigation found
 * no CDN/redirect/Content-Type deviation from a well-behaved single-origin
 * OPDS server) — a real deviation, if ever found, gets its own override
 * here rather than an `if (provider === "memlane")` branch spread through
 * service.ts/fetch.ts.
 */
export interface OpdsProviderAdapter {
  /** Lets a provider normalize/canonicalize the raw create-connection input before validation (e.g. trimming, default name) — identity for genericAdapter. */
  normalizeConnectionInput<T>(input: T): T;
  /** Throws (an ApiError) if the root feed response isn't recognizable as this provider's OPDS catalog — called before the body is read as text. */
  validateCatalogResponse(response: Response): Promise<void>;
  /** Whether `target` is an acceptable navigation/search feed URL for this connection (spec §15's "navigation/searchは原則同一origin"). */
  isAllowedNavigationUrl(connection: DecryptedOpdsConnection, target: URL): boolean;
  /** Whether `target` is an acceptable EPUB acquisition URL for this connection (spec §15's "acquisitionは同一originを原則"). */
  isAllowedAcquisitionUrl(connection: DecryptedOpdsConnection, target: URL): boolean;
  /** Lets a provider rewrite a parsed entry (e.g. title cleanup) before it's mapped to the API shape — identity for genericAdapter. */
  normalizeEntry(entry: ParsedOpdsEntry): ParsedOpdsEntry;
}
