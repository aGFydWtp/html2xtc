// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { EncryptedOpdsField, OpdsConnectionField } from "./connection-crypto";
import { decryptOpdsConnectionField, encryptOpdsConnectionField } from "./connection-crypto";
import type { DecryptOpdsCursorResult, OpdsCursorKind, OpdsCursorPayload } from "./cursor-crypto";
import { MAX_OPDS_CURSOR_DEPTH, decryptOpdsCursor, encryptOpdsCursor } from "./cursor-crypto";
import { opaqueOpdsEntryId } from "./entry-id";
import type { OpdsFetchRequest, OpdsFetchResult } from "./fetch";
import { buildOpdsAuthHeaders, fetchOpdsResource, readLimitedText, validateOpdsExternalUrl } from "./fetch";
import { buildOpdsSearchUrl, parseOpenSearchTemplate } from "./opensearch";
import { parseOpdsFeedXml } from "./parser-v1";
import { resolveOpdsProviderAdapter } from "./providers";
import type { NewOpdsConnection, StoredOpdsConnection } from "./repository";
import {
  deleteOpdsConnection,
  getOpdsConnectionById,
  listOpdsConnectionSummaries,
  opdsConnectionExists,
  replaceOpdsConnection,
} from "./repository";
import type { DecryptedOpdsConnection, OpdsAuthType, OpdsConnectionSummary, OpdsProvider } from "./types";
import { isOpdsAuthType, isOpdsProvider } from "./types";
import { createStoredEpubJob } from "../../epub-job";
import type { EpubConvertOptions } from "../../epub-options";
import { validateEpubConvertOptions } from "../../epub-options";
import {
  hasEpubZipMagic,
  peekLeadingBytes,
  resolveMaxUploadEpubBytes,
  sanitizeUploadEpubFilename,
} from "../../epub-upload";
import { logAuditEvent } from "../../security/audit";
import { Errors } from "../../security/errors";
import type { Env } from "../../types";
import { UrlValidationError } from "../../validate";

/**
 * Business logic for the generic OPDS integration (spec §13). Every
 * exported function here assumes the caller (src/integrations/opds/
 * routes.ts) already did session auth, CSRF, the feature-flag gate, and
 * rate limiting — this module focuses on connection lifecycle, catalog
 * traversal, and the EPUB import handoff.
 */

const MAX_NAME_CHARS = 100;
const MAX_CATALOG_URL_CHARS = 2048;
const MAX_CREDENTIAL_CHARS = 200;
const MAX_FETCHED_FEED_BYTES = 1_048_576; // matches parser-v1.ts's own cap — enforced here too, before the whole body is even buffered into a string
const MAX_FETCHED_OPENSEARCH_BYTES = 65_536; // matches opensearch.ts's MAX_OPENSEARCH_XML_BYTES — description documents are tiny; reading with the 1 MiB feed budget would buffer 16x more than parseOpenSearchTemplate could ever accept

// --- input validation ------------------------------------------------------

function readRequiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw Errors.badRequest("OPDS_CONNECTION_INVALID", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    throw Errors.badRequest("OPDS_CONNECTION_INVALID", `${field} must be between 1 and ${maxChars} characters`);
  }
  return trimmed;
}

function readProvider(value: unknown): OpdsProvider {
  if (!isOpdsProvider(value)) {
    throw Errors.badRequest("OPDS_CONNECTION_INVALID", "invalid provider");
  }
  return value;
}

function readAuthType(value: unknown): OpdsAuthType {
  if (!isOpdsAuthType(value)) {
    throw Errors.badRequest("OPDS_CONNECTION_INVALID", "invalid authType");
  }
  return value;
}

function readOptionalCredential(value: unknown, field: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CREDENTIAL_CHARS) {
    throw Errors.badRequest("OPDS_CONNECTION_INVALID", `${field} must be a non-empty string`);
  }
  return value;
}

/** Spec §13.3: "Memlane: provider=memlane / authType=url_secret / username/password禁止", "generic: authType=none|url_secret|basic". */
function validateProviderAuthCombo(
  provider: OpdsProvider,
  authType: OpdsAuthType,
  hasUsername: boolean,
  hasPassword: boolean,
): void {
  if (provider === "memlane") {
    if (authType !== "url_secret") {
      throw Errors.badRequest("OPDS_CONNECTION_INVALID", "memlane connections require authType=url_secret");
    }
    if (hasUsername || hasPassword) {
      throw Errors.badRequest("OPDS_CONNECTION_INVALID", "memlane connections do not accept username/password");
    }
    return;
  }
  if (authType === "basic") {
    if (!hasUsername || !hasPassword) {
      throw Errors.badRequest("OPDS_CONNECTION_INVALID", "authType=basic requires both username and password");
    }
  } else if (hasUsername || hasPassword) {
    throw Errors.badRequest("OPDS_CONNECTION_INVALID", "username/password are only accepted with authType=basic");
  }
}

// --- shared fetch/parse helpers --------------------------------------------

async function fetchOpdsFeedResource(url: URL, request: OpdsFetchRequest): Promise<OpdsFetchResult> {
  try {
    return await fetchOpdsResource(url, request);
  } catch {
    // Covers both a network-level failure (DNS/TLS/timeout — fetch() itself
    // throws) and a UrlValidationError raised by fetchOpdsResource's own
    // per-redirect re-validation: either way this is the upstream server
    // misbehaving, not a problem with the request this Worker sent (spec
    // §15's URL never appears in the thrown message).
    throw Errors.badGateway("OPDS_UPSTREAM_ERROR", "failed to reach the OPDS server");
  }
}

function assertOkResponse(response: Response): void {
  if (!response.ok) {
    throw Errors.badGateway("OPDS_UPSTREAM_ERROR", "the OPDS server returned an error");
  }
}

async function readFeedTextOrThrow(response: Response, maxBytes: number = MAX_FETCHED_FEED_BYTES): Promise<string> {
  try {
    return await readLimitedText(response, maxBytes);
  } catch {
    throw Errors.unprocessable("OPDS_FEED_INVALID", "feed exceeds the maximum allowed size");
  }
}

function safeParseUrl(value: string | undefined): URL | null {
  if (value === undefined) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// --- defense-in-depth: title/author secret scrubbing -----------------------

/**
 * Matches any `scheme://` — deliberately broad (not anchored to https, not
 * requiring a recognizable TLD) because the point isn't to validate a URL,
 * only to flag "this display string embeds something URL-shaped that
 * shouldn't be here".
 */
const URL_SCHEME_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const SANITIZED_TITLE_PLACEHOLDER = "(hidden)";

interface SanitizeStats {
  sanitizedCount: number;
}

/**
 * opaqueOpdsEntryId already stops a feed/entry `<id>` from ever reaching the
 * client verbatim, but the Memlane investigation (spec §7) only confirmed
 * `<id>` carries the secret URL — nothing about the feed format guarantees
 * `<title>`/`<author><name>` can't ALSO carry it (or some other credential-
 * shaped string), and unlike `<id>` those fields are never opacified because
 * they're meant to be shown as-is. This is the last line of defense before
 * feed.title / entry.title / entry.author reach the response: flags a string
 * containing this connection's own origin/host (the exact secret this
 * connection was configured with) or anything URL-scheme-shaped in general
 * (a different server's secret, or a scheme this check didn't anticipate).
 */
function containsPotentialSecretUrl(value: string, connection: DecryptedOpdsConnection): boolean {
  return value.includes(connection.origin) || value.includes(connection.host) || URL_SCHEME_PATTERN.test(value);
}

/** Sanitizes a required display string (feed/entry title) — the whole string is replaced by a placeholder rather than trying to surgically cut out only the offending substring, since a partial cut could still leave adjacent secret fragments legible. */
function sanitizeTitleForResponse(value: string, connection: DecryptedOpdsConnection, stats: SanitizeStats): string {
  if (!containsPotentialSecretUrl(value, connection)) {
    return value;
  }
  stats.sanitizedCount += 1;
  return SANITIZED_TITLE_PLACEHOLDER;
}

/** Sanitizes an optional display string (entry author) — dropped to null (an absent author is already a normal, unremarkable shape) rather than given a placeholder, since author has no must-display requirement the way title does. */
function sanitizeAuthorForResponse(
  value: string | null,
  connection: DecryptedOpdsConnection,
  stats: SanitizeStats,
): string | null {
  if (value === null || !containsPotentialSecretUrl(value, connection)) {
    return value;
  }
  stats.sanitizedCount += 1;
  return null;
}

async function decryptField(
  env: Pick<Env, "OPDS_CONNECTION_ENCRYPTION_KEY">,
  accountId: string,
  connectionId: string,
  field: OpdsConnectionField,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  authTag: Uint8Array,
): Promise<string> {
  return decryptOpdsConnectionField(env, { accountId, connectionId, field }, { ciphertext, iv, authTag });
}

/** Decrypts every credential field a stored row carries into an in-memory-only DecryptedOpdsConnection. */
async function decryptStoredConnection(env: Env, stored: StoredOpdsConnection): Promise<DecryptedOpdsConnection> {
  const catalogUrl = await decryptField(
    env,
    stored.accountId,
    stored.id,
    "catalog_url",
    stored.catalogUrlCiphertext,
    stored.catalogUrlIv,
    stored.catalogUrlAuthTag,
  );

  let username: string | null = null;
  let password: string | null = null;
  if (stored.authType === "basic") {
    if (
      stored.usernameCiphertext === null ||
      stored.usernameIv === null ||
      stored.usernameAuthTag === null ||
      stored.passwordCiphertext === null ||
      stored.passwordIv === null ||
      stored.passwordAuthTag === null
    ) {
      throw Errors.internal("stored OPDS connection is missing Basic credentials");
    }
    username = await decryptField(
      env,
      stored.accountId,
      stored.id,
      "username",
      stored.usernameCiphertext,
      stored.usernameIv,
      stored.usernameAuthTag,
    );
    password = await decryptField(
      env,
      stored.accountId,
      stored.id,
      "password",
      stored.passwordCiphertext,
      stored.passwordIv,
      stored.passwordAuthTag,
    );
  }

  return {
    id: stored.id,
    accountId: stored.accountId,
    provider: stored.provider,
    authType: stored.authType,
    catalogUrl,
    origin: stored.origin,
    host: stored.host,
    username,
    password,
  };
}

// --- connection list / create / delete -------------------------------------

export async function listOpdsConnections(
  env: Pick<Env, "APP_DB">,
  accountId: string,
): Promise<OpdsConnectionSummary[]> {
  return listOpdsConnectionSummaries(env.APP_DB, accountId);
}

/**
 * Create-or-replace (spec §13.3/§13.4): validates input shape, the
 * provider/authType combination, and the URL; fetches and parses the root
 * feed to confirm the connection actually works BEFORE any credential is
 * encrypted or persisted (so a failed verification never disturbs an
 * existing connection — spec §8.3/§26 "新接続検証成功まで旧接続を維持");
 * then atomically replaces any prior (accountId, provider, name) row.
 */
export async function createOrReplaceOpdsConnection(
  env: Env,
  accountId: string,
  rawInput: Record<string, unknown>,
): Promise<{ connection: OpdsConnectionSummary }> {
  const name = readRequiredString(rawInput.name, "name", MAX_NAME_CHARS);
  const provider = readProvider(rawInput.provider);
  const authType = readAuthType(rawInput.authType);
  const catalogUrlRaw = readRequiredString(rawInput.catalogUrl, "catalogUrl", MAX_CATALOG_URL_CHARS);
  const username = readOptionalCredential(rawInput.username, "username");
  const password = readOptionalCredential(rawInput.password, "password");

  validateProviderAuthCombo(provider, authType, username !== null, password !== null);

  let validatedUrl: URL;
  try {
    validatedUrl = await validateOpdsExternalUrl(catalogUrlRaw);
  } catch (error) {
    throw error instanceof UrlValidationError
      ? Errors.badRequest("OPDS_CONNECTION_INVALID", error.message)
      : error;
  }

  const connectionId = crypto.randomUUID();
  const candidate: DecryptedOpdsConnection = {
    id: connectionId,
    accountId,
    provider,
    authType,
    catalogUrl: validatedUrl.toString(),
    origin: validatedUrl.origin,
    host: validatedUrl.hostname,
    username,
    password,
  };

  const adapter = resolveOpdsProviderAdapter(provider);
  const { response, finalUrl } = await fetchOpdsFeedResource(validatedUrl, buildOpdsAuthHeaders(candidate));
  assertOkResponse(response);
  await adapter.validateCatalogResponse(response);
  const xml = await readFeedTextOrThrow(response);
  // Parse-only verification: nothing from the parsed feed is returned here
  // — this only confirms the URL is really a usable OPDS feed before any
  // credential for it is ever persisted (spec §13.3 steps 9-11).
  parseOpdsFeedXml(xml, finalUrl.toString());

  const nowIso = new Date().toISOString();
  const catalogUrlEnc = await encryptOpdsConnectionField(
    env,
    { accountId, connectionId, field: "catalog_url" },
    candidate.catalogUrl,
  );
  let usernameEnc: EncryptedOpdsField | null = null;
  let passwordEnc: EncryptedOpdsField | null = null;
  if (authType === "basic") {
    usernameEnc = await encryptOpdsConnectionField(
      env,
      { accountId, connectionId, field: "username" },
      username as string,
    );
    passwordEnc = await encryptOpdsConnectionField(
      env,
      { accountId, connectionId, field: "password" },
      password as string,
    );
  }

  const existed = await opdsConnectionExists(env.APP_DB, accountId, provider, name);

  const row: NewOpdsConnection = {
    id: connectionId,
    accountId,
    name,
    provider,
    authType,
    catalogUrlCiphertext: catalogUrlEnc.ciphertext,
    catalogUrlIv: catalogUrlEnc.iv,
    catalogUrlAuthTag: catalogUrlEnc.authTag,
    usernameCiphertext: usernameEnc?.ciphertext ?? null,
    usernameIv: usernameEnc?.iv ?? null,
    usernameAuthTag: usernameEnc?.authTag ?? null,
    passwordCiphertext: passwordEnc?.ciphertext ?? null,
    passwordIv: passwordEnc?.iv ?? null,
    passwordAuthTag: passwordEnc?.authTag ?? null,
    origin: candidate.origin,
    host: candidate.host,
    createdAt: nowIso,
  };
  await replaceOpdsConnection(env.APP_DB, row);

  logAuditEvent(existed ? "integration.opds.replaced" : "integration.opds.connected", {
    accountId,
    connectionId,
    provider,
    authType,
    host: candidate.host,
  });

  return {
    connection: { id: connectionId, name, provider, authType, host: candidate.host, lastVerifiedAt: nowIso },
  };
}

/**
 * DELETE (spec §13.5/§24.6 "冪等方針"): always succeeds from the caller's
 * point of view whether or not a row actually existed — deleting an
 * unknown or already-deleted id is not an error, and this never reveals
 * whether a given id belongs to another account.
 */
export async function deleteOpdsConnectionForAccount(
  env: Pick<Env, "APP_DB">,
  accountId: string,
  connectionId: string,
): Promise<void> {
  await deleteOpdsConnection(env.APP_DB, accountId, connectionId);
  logAuditEvent("integration.opds.disconnected", { accountId, connectionId });
}

// --- catalog ----------------------------------------------------------------

export interface OpdsApiNavigationEntry {
  kind: "navigation";
  id: string;
  title: string;
  cursor: string;
}

export interface OpdsApiPublicationEntry {
  kind: "publication";
  id: string;
  title: string;
  author: string | null;
  updatedAt: string | null;
  canImportEpub: boolean;
  acquisitionCursor: string | null;
}

export type OpdsApiEntry = OpdsApiNavigationEntry | OpdsApiPublicationEntry;

export interface OpdsCatalogPageResult {
  title: string;
  entries: OpdsApiEntry[];
  nextCursor: string | null;
  previousCursor: string | null;
  searchSupported: boolean;
  searchCursor: string | null;
}

export interface FetchOpdsCatalogPageParams {
  cursor?: string;
  search?: string;
}

function requireCursorOk(decoded: DecryptOpdsCursorResult): OpdsCursorPayload {
  if (!decoded.ok) {
    throw Errors.badRequest("OPDS_CURSOR_INVALID", decoded.reason);
  }
  return decoded.payload;
}

function requireCursorMatches(payload: OpdsCursorPayload, accountId: string, connectionId: string): void {
  if (payload.accountId !== accountId || payload.connectionId !== connectionId) {
    throw Errors.badRequest("OPDS_CURSOR_INVALID", "cursor does not match this connection");
  }
}

/** Re-validates a cursor-embedded URL, mapping any failure to OPDS_CURSOR_INVALID (this URL was already validated once at issuance — a failure now means tampering or a stale/rotated DNS answer, not a fresh client mistake). */
async function revalidateCursorUrl(raw: string): Promise<URL> {
  try {
    return await validateOpdsExternalUrl(raw);
  } catch (error) {
    throw error instanceof UrlValidationError ? Errors.badRequest("OPDS_CURSOR_INVALID", error.message) : error;
  }
}

/**
 * Picks the adapter policy matching `kind`: acquisition_epub cursors must be
 * checked against isAllowedAcquisitionUrl, every other kind (navigation/
 * search/next/previous) against isAllowedNavigationUrl. Today the generic
 * adapter's two policies are identical bodies (same-origin), so this had no
 * observable effect either way — but a future adapter that legitimately
 * distinguishes them (e.g. an acquisition CDN allow-list) must not have its
 * acquisition links silently gated by the navigation policy instead.
 */
function isAllowedForCursorKind(
  adapter: ReturnType<typeof resolveOpdsProviderAdapter>,
  connection: DecryptedOpdsConnection,
  kind: OpdsCursorKind,
  url: URL,
): boolean {
  return kind === "acquisition_epub"
    ? adapter.isAllowedAcquisitionUrl(connection, url)
    : adapter.isAllowedNavigationUrl(connection, url);
}

async function issueCursorOrNull(
  env: Pick<Env, "OPDS_CURSOR_ENCRYPTION_KEY">,
  connection: DecryptedOpdsConnection,
  adapter: ReturnType<typeof resolveOpdsProviderAdapter>,
  connectionId: string,
  kind: OpdsCursorKind,
  href: string | null,
  depth: number,
): Promise<string | null> {
  if (href === null || depth > MAX_OPDS_CURSOR_DEPTH) {
    return null;
  }
  const url = safeParseUrl(href);
  if (url === null || !isAllowedForCursorKind(adapter, connection, kind, url)) {
    return null;
  }
  return encryptOpdsCursor(env, { accountId: connection.accountId, connectionId, kind, url: href, depth });
}

/** GET /api/integrations/opds/{connectionId}/catalog (spec §13.6). */
export async function fetchOpdsCatalogPage(
  env: Env,
  accountId: string,
  connectionId: string,
  params: FetchOpdsCatalogPageParams,
): Promise<OpdsCatalogPageResult> {
  const stored = await getOpdsConnectionById(env.APP_DB, accountId, connectionId);
  if (stored === null) {
    throw Errors.notFound("OPDS_CONNECTION_NOT_FOUND", "OPDS connection not found");
  }
  const connection = await decryptStoredConnection(env, stored);
  const adapter = resolveOpdsProviderAdapter(connection.provider);

  let targetUrl: URL;
  let depth: number;

  if (params.cursor !== undefined) {
    const payload = requireCursorOk(await decryptOpdsCursor(env, params.cursor));
    requireCursorMatches(payload, accountId, connectionId);
    if (payload.kind === "acquisition_epub") {
      throw Errors.badRequest("OPDS_CURSOR_INVALID", "cursor is not a catalog cursor");
    }

    if (payload.kind === "search") {
      if (params.search === undefined) {
        throw Errors.badRequest("OPDS_CURSOR_INVALID", "search requires a query");
      }
      const openSearchUrl = await revalidateCursorUrl(payload.url);
      if (!adapter.isAllowedNavigationUrl(connection, openSearchUrl)) {
        throw Errors.badRequest("OPDS_CONNECTION_INVALID", "search URL is not allowed for this connection");
      }
      const openSearchResult = await fetchOpdsFeedResource(openSearchUrl, buildOpdsAuthHeaders(connection));
      assertOkResponse(openSearchResult.response);
      const openSearchXml = await readFeedTextOrThrow(openSearchResult.response, MAX_FETCHED_OPENSEARCH_BYTES);
      const template = parseOpenSearchTemplate(openSearchXml, openSearchResult.finalUrl.toString());
      if (template === null) {
        throw Errors.unprocessable("OPDS_FEED_INVALID", "OpenSearch description has no usable template");
      }
      const searchUrlRaw = buildOpdsSearchUrl(template, params.search);
      if (searchUrlRaw === null) {
        throw Errors.unprocessable("OPDS_FEED_INVALID", "OpenSearch template has no {searchTerms} placeholder");
      }
      targetUrl = await revalidateCursorUrl(searchUrlRaw);
      depth = payload.depth;
    } else {
      // navigation / next / previous
      targetUrl = await revalidateCursorUrl(payload.url);
      depth = payload.depth;
    }
  } else {
    if (params.search !== undefined) {
      throw Errors.badRequest("OPDS_CURSOR_INVALID", "search requires a cursor from a previously fetched page");
    }
    targetUrl = await revalidateCursorUrl(connection.catalogUrl);
    depth = 0;
  }

  if (!adapter.isAllowedNavigationUrl(connection, targetUrl)) {
    throw Errors.badRequest("OPDS_CONNECTION_INVALID", "target URL is not allowed for this connection");
  }

  const { response, finalUrl } = await fetchOpdsFeedResource(targetUrl, buildOpdsAuthHeaders(connection));
  assertOkResponse(response);
  await adapter.validateCatalogResponse(response);
  const xml = await readFeedTextOrThrow(response);
  const feed = parseOpdsFeedXml(xml, finalUrl.toString());

  const childDepth = depth + 1;
  const sanitizeStats: SanitizeStats = { sanitizedCount: 0 };
  const entries: OpdsApiEntry[] = [];
  for (const rawEntry of feed.entries) {
    const entry = adapter.normalizeEntry(rawEntry);
    const id = await opaqueOpdsEntryId(env, connectionId, entry.sourceId);
    const title = sanitizeTitleForResponse(entry.title, connection, sanitizeStats);

    if (entry.kind === "navigation") {
      const cursor = await issueCursorOrNull(
        env,
        connection,
        adapter,
        connectionId,
        "navigation",
        entry.navigationHref ?? null,
        childDepth,
      );
      if (cursor === null) {
        continue; // depth-capped, disallowed origin, or unparseable href — omit rather than error
      }
      entries.push({ kind: "navigation", id, title, cursor });
      continue;
    }

    const acquisitionCursor = await issueCursorOrNull(
      env,
      connection,
      adapter,
      connectionId,
      "acquisition_epub",
      entry.acquisitionHref ?? null,
      depth,
    );
    entries.push({
      kind: "publication",
      id,
      title,
      author: sanitizeAuthorForResponse(entry.author, connection, sanitizeStats),
      updatedAt: entry.updated,
      canImportEpub: acquisitionCursor !== null,
      acquisitionCursor,
    });
  }

  const nextCursor = await issueCursorOrNull(env, connection, adapter, connectionId, "next", feed.nextHref, depth);
  const previousCursor = await issueCursorOrNull(
    env,
    connection,
    adapter,
    connectionId,
    "previous",
    feed.previousHref,
    depth,
  );
  const searchCursor = await issueCursorOrNull(
    env,
    connection,
    adapter,
    connectionId,
    "search",
    feed.searchHref,
    depth,
  );

  const title = sanitizeTitleForResponse(feed.title, connection, sanitizeStats);

  logAuditEvent("integration.opds.catalog_fetched", {
    accountId,
    connectionId,
    provider: connection.provider,
    host: connection.host,
    ...(sanitizeStats.sanitizedCount > 0 ? { sanitizedFieldCount: sanitizeStats.sanitizedCount } : {}),
  });

  return {
    title,
    entries,
    nextCursor,
    previousCursor,
    searchSupported: searchCursor !== null,
    searchCursor,
  };
}

// --- import ------------------------------------------------------------------

export interface StartOpdsImportInput {
  acquisitionCursor: unknown;
  title?: unknown;
  epubOptions: unknown;
}

export interface StartOpdsImportResult {
  jobId: string;
  statusUrl: string;
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Small Content-Disposition filename extractor — Memlane's real responses (spec §7) use a plain ASCII `attachment; filename="...epub"`, so this deliberately doesn't attempt RFC 5987 `filename*` decoding. */
function parseContentDispositionFilename(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const quoted = /filename="([^"]*)"/i.exec(value);
  if (quoted?.[1] !== undefined && quoted[1].length > 0) {
    return quoted[1];
  }
  const bare = /filename=([^;]+)/i.exec(value);
  const bareValue = bare?.[1]?.trim();
  return bareValue !== undefined && bareValue.length > 0 ? bareValue : null;
}

/** Spec §19 priority: Content-Disposition -> OPDS entry title -> default. Never derives a filename from the URL path (which may carry a secret). */
function resolveImportFilename(contentDisposition: string | null, entryTitle: string | undefined): string {
  const fromHeader = parseContentDispositionFilename(contentDisposition);
  if (fromHeader !== null) {
    return sanitizeUploadEpubFilename(fromHeader);
  }
  if (entryTitle !== undefined && entryTitle.trim().length > 0) {
    return sanitizeUploadEpubFilename(entryTitle);
  }
  return sanitizeUploadEpubFilename("");
}

/** POST /api/integrations/opds/{connectionId}/import (spec §13.7/§17). */
export async function startOpdsImport(
  env: Env,
  accountId: string,
  connectionId: string,
  input: StartOpdsImportInput,
): Promise<StartOpdsImportResult> {
  if (typeof input.acquisitionCursor !== "string" || input.acquisitionCursor.length === 0) {
    throw Errors.badRequest("OPDS_CURSOR_INVALID", "acquisitionCursor is required");
  }
  if (input.title !== undefined && typeof input.title !== "string") {
    throw Errors.badRequest("INVALID_TITLE", "title must be a string");
  }
  const optionsResult = validateEpubConvertOptions(input.epubOptions);
  if (!optionsResult.ok) {
    throw Errors.badRequest("INVALID_EPUB_OPTIONS", optionsResult.error);
  }
  const epubOptions: EpubConvertOptions = optionsResult.options;

  const payload = requireCursorOk(await decryptOpdsCursor(env, input.acquisitionCursor));
  if (payload.kind !== "acquisition_epub") {
    throw Errors.badRequest("OPDS_CURSOR_INVALID", "cursor is not an acquisition cursor");
  }
  requireCursorMatches(payload, accountId, connectionId);

  const stored = await getOpdsConnectionById(env.APP_DB, accountId, connectionId);
  if (stored === null) {
    throw Errors.notFound("OPDS_CONNECTION_NOT_FOUND", "OPDS connection not found");
  }
  const connection = await decryptStoredConnection(env, stored);
  const adapter = resolveOpdsProviderAdapter(connection.provider);

  function failImport(category: string): void {
    logAuditEvent("integration.opds.import_failed", {
      accountId,
      connectionId,
      provider: connection.provider,
      failureCategory: category,
    });
  }

  const acquisitionUrl = await revalidateCursorUrl(payload.url).catch((error) => {
    failImport("invalid_url");
    throw error;
  });
  if (!adapter.isAllowedAcquisitionUrl(connection, acquisitionUrl)) {
    failImport("disallowed_url");
    throw Errors.badRequest("OPDS_CURSOR_INVALID", "acquisition URL is not allowed for this connection");
  }

  let fetchResult: OpdsFetchResult;
  try {
    fetchResult = await fetchOpdsResource(acquisitionUrl, buildOpdsAuthHeaders(connection));
  } catch {
    failImport("fetch_failed");
    throw Errors.badGateway("OPDS_UPSTREAM_ERROR", "failed to reach the OPDS server");
  }
  const { response } = fetchResult;
  if (!response.ok) {
    failImport("upstream_error");
    throw Errors.badGateway("OPDS_UPSTREAM_ERROR", "the OPDS server returned an error");
  }

  const contentType = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/epub+zip" && contentType !== "application/octet-stream") {
    failImport("bad_content_type");
    throw Errors.badGateway("OPDS_EPUB_UNAVAILABLE", "unexpected EPUB response Content-Type");
  }

  const maxUploadBytes = resolveMaxUploadEpubBytes(env);
  const declaredSize = parseContentLength(response.headers.get("Content-Length"));
  if (declaredSize === null) {
    failImport("missing_content_length");
    throw Errors.badGateway("OPDS_EPUB_UNAVAILABLE", "EPUB response did not include a usable Content-Length");
  }
  if (declaredSize > maxUploadBytes) {
    failImport("too_large");
    throw Errors.payloadTooLarge("OPDS_EPUB_UNAVAILABLE", "EPUB exceeds the maximum allowed size");
  }
  if (response.body === null) {
    failImport("empty_body");
    throw Errors.badGateway("OPDS_EPUB_UNAVAILABLE", "EPUB response had no body");
  }

  const { leading, body } = await peekLeadingBytes(response.body, 4);
  if (!hasEpubZipMagic(leading)) {
    failImport("not_a_zip");
    throw Errors.badGateway("OPDS_EPUB_UNAVAILABLE", "EPUB response was not a valid ZIP archive");
  }

  const filename = resolveImportFilename(
    response.headers.get("Content-Disposition"),
    typeof input.title === "string" ? input.title : undefined,
  );

  const result = await createStoredEpubJob(env, {
    body,
    declaredSize,
    filename,
    epubOptions,
    sourceMetadata: { sourceType: "opds", provider: connection.provider, connectionId },
  });
  if (!result.ok) {
    failImport("store_failed");
    throw Errors.badGateway("OPDS_EPUB_UNAVAILABLE", result.error);
  }

  logAuditEvent("integration.opds.import_started", {
    accountId,
    connectionId,
    provider: connection.provider,
    jobId: result.jobId,
    sizeBytes: declaredSize,
  });

  return { jobId: result.jobId, statusUrl: result.statusUrl };
}
