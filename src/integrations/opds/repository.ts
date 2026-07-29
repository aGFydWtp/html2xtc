// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { toArrayBuffer } from "./connection-crypto";
import type { OpdsAuthType, OpdsConnectionSummary, OpdsProvider } from "./types";

/**
 * D1 access for opds_connections (migrations/app/0007_opds_connections.sql).
 * Row (snake_case) <-> app (camelCase) mapping follows the same convention
 * as src/auth/repository.ts / src/library/repository.ts. Every function
 * here is scoped by accountId (never trusts a bare connectionId alone) —
 * ownership is enforced at the SQL WHERE clause, not just at the caller.
 */

export interface StoredOpdsConnection {
  id: string;
  accountId: string;
  name: string;
  provider: OpdsProvider;
  authType: OpdsAuthType;
  catalogUrlCiphertext: Uint8Array;
  catalogUrlIv: Uint8Array;
  catalogUrlAuthTag: Uint8Array;
  usernameCiphertext: Uint8Array | null;
  usernameIv: Uint8Array | null;
  usernameAuthTag: Uint8Array | null;
  passwordCiphertext: Uint8Array | null;
  passwordIv: Uint8Array | null;
  passwordAuthTag: Uint8Array | null;
  origin: string;
  host: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
}

interface OpdsConnectionRow {
  id: string;
  account_id: string;
  name: string;
  provider: string;
  auth_type: string;
  catalog_url_ciphertext: ArrayBuffer;
  catalog_url_iv: ArrayBuffer;
  catalog_url_auth_tag: ArrayBuffer;
  username_ciphertext: ArrayBuffer | null;
  username_iv: ArrayBuffer | null;
  username_auth_tag: ArrayBuffer | null;
  password_ciphertext: ArrayBuffer | null;
  password_iv: ArrayBuffer | null;
  password_auth_tag: ArrayBuffer | null;
  origin: string;
  host: string;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
}

interface OpdsConnectionSummaryRow {
  id: string;
  name: string;
  provider: string;
  auth_type: string;
  host: string;
  last_verified_at: string | null;
}

function toBytes(value: ArrayBuffer | null): Uint8Array | null {
  return value === null ? null : new Uint8Array(value);
}

function fromRow(row: OpdsConnectionRow): StoredOpdsConnection {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    provider: row.provider as OpdsProvider,
    authType: row.auth_type as OpdsAuthType,
    catalogUrlCiphertext: new Uint8Array(row.catalog_url_ciphertext),
    catalogUrlIv: new Uint8Array(row.catalog_url_iv),
    catalogUrlAuthTag: new Uint8Array(row.catalog_url_auth_tag),
    usernameCiphertext: toBytes(row.username_ciphertext),
    usernameIv: toBytes(row.username_iv),
    usernameAuthTag: toBytes(row.username_auth_tag),
    passwordCiphertext: toBytes(row.password_ciphertext),
    passwordIv: toBytes(row.password_iv),
    passwordAuthTag: toBytes(row.password_auth_tag),
    origin: row.origin,
    host: row.host,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

function fromSummaryRow(row: OpdsConnectionSummaryRow): OpdsConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as OpdsProvider,
    authType: row.auth_type as OpdsAuthType,
    host: row.host,
    lastVerifiedAt: row.last_verified_at,
  };
}

/** GET /api/integrations/opds (spec §13.1) — deliberately never selects the ciphertext columns, so a secret can never leak through this path even by a future bug in the route handler. */
export async function listOpdsConnectionSummaries(
  db: D1Database,
  accountId: string,
): Promise<OpdsConnectionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, provider, auth_type, host, last_verified_at
       FROM opds_connections WHERE account_id = ? ORDER BY created_at ASC`,
    )
    .bind(accountId)
    .all<OpdsConnectionSummaryRow>();
  return results.map(fromSummaryRow);
}

/** Full row (incl. ciphertext) for a connection this account owns — null if it doesn't exist or belongs to another account (ownership is enforced in the WHERE clause, not just by the caller). */
export async function getOpdsConnectionById(
  db: D1Database,
  accountId: string,
  connectionId: string,
): Promise<StoredOpdsConnection | null> {
  const row = await db
    .prepare(`SELECT * FROM opds_connections WHERE id = ? AND account_id = ?`)
    .bind(connectionId, accountId)
    .first<OpdsConnectionRow>();
  return row === null ? null : fromRow(row);
}

/** Whether this account already has a (provider, name) row — used only to choose the "connected"/"replaced" audit event; never exposes any credential. */
export async function opdsConnectionExists(
  db: D1Database,
  accountId: string,
  provider: OpdsProvider,
  name: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM opds_connections WHERE account_id = ? AND provider = ? AND name = ?`)
    .bind(accountId, provider, name)
    .first<{ id: string }>();
  return row !== null;
}

export interface NewOpdsConnection {
  id: string;
  accountId: string;
  name: string;
  provider: OpdsProvider;
  authType: OpdsAuthType;
  catalogUrlCiphertext: Uint8Array;
  catalogUrlIv: Uint8Array;
  catalogUrlAuthTag: Uint8Array;
  usernameCiphertext: Uint8Array | null;
  usernameIv: Uint8Array | null;
  usernameAuthTag: Uint8Array | null;
  passwordCiphertext: Uint8Array | null;
  passwordIv: Uint8Array | null;
  passwordAuthTag: Uint8Array | null;
  origin: string;
  host: string;
  createdAt: string;
}

function buildInsertStatement(db: D1Database, row: NewOpdsConnection): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO opds_connections (
         id, account_id, name, provider, auth_type,
         catalog_url_ciphertext, catalog_url_iv, catalog_url_auth_tag,
         username_ciphertext, username_iv, username_auth_tag,
         password_ciphertext, password_iv, password_auth_tag,
         origin, host, created_at, updated_at, last_verified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.accountId,
      row.name,
      row.provider,
      row.authType,
      toArrayBuffer(row.catalogUrlCiphertext),
      toArrayBuffer(row.catalogUrlIv),
      toArrayBuffer(row.catalogUrlAuthTag),
      row.usernameCiphertext !== null ? toArrayBuffer(row.usernameCiphertext) : null,
      row.usernameIv !== null ? toArrayBuffer(row.usernameIv) : null,
      row.usernameAuthTag !== null ? toArrayBuffer(row.usernameAuthTag) : null,
      row.passwordCiphertext !== null ? toArrayBuffer(row.passwordCiphertext) : null,
      row.passwordIv !== null ? toArrayBuffer(row.passwordIv) : null,
      row.passwordAuthTag !== null ? toArrayBuffer(row.passwordAuthTag) : null,
      row.origin,
      row.host,
      row.createdAt,
      row.createdAt, // updated_at == created_at on insert
      row.createdAt, // last_verified_at: the root feed was just fetched+parsed successfully as part of creating this connection (spec §13.3 step 9), so "verified" == "created" here
    );
}

function buildDeleteByProviderNameStatement(
  db: D1Database,
  accountId: string,
  provider: OpdsProvider,
  name: string,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM opds_connections WHERE account_id = ? AND provider = ? AND name = ?`)
    .bind(accountId, provider, name);
}

/**
 * Atomically replaces any existing (accountId, provider, name) row with
 * `row` (spec §13.3 step 15 / §13.4's recommended replace-not-update
 * approach) — a single D1 batch() so a reader never observes a state with
 * both the old and new row, or neither. Works identically for a first-time
 * create (the DELETE simply matches zero rows) and a replace, so callers
 * don't need two code paths. Because `row.id` is always a freshly generated
 * id (never the old connection's id — spec §11.1's recommendation), any
 * cursor issued against the old connection stops resolving the moment this
 * commits (its connectionId no longer exists), without any separate
 * cursor-invalidation step.
 */
export async function replaceOpdsConnection(db: D1Database, row: NewOpdsConnection): Promise<void> {
  await db.batch([
    buildDeleteByProviderNameStatement(db, row.accountId, row.provider, row.name),
    buildInsertStatement(db, row),
  ]);
}

/** DELETE /api/integrations/opds/{connectionId} (spec §13.5). Returns whether a row was actually deleted (idempotent from the caller's perspective — a second DELETE of an already-gone id is not an error). */
export async function deleteOpdsConnection(
  db: D1Database,
  accountId: string,
  connectionId: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM opds_connections WHERE id = ? AND account_id = ?`)
    .bind(connectionId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
