// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import type { Account } from "./sessions";

/**
 * D1 access for accounts, webauthn_credentials, and registration_invites.
 * Row (snake_case) <-> app (camelCase) mapping follows the same convention
 * as src/catalog-db.ts and src/library/repository.ts. src/auth/webauthn.ts
 * is the service layer that calls into this module.
 */

/** Builds (without running) the accounts INSERT statement — used standalone by createAccount and as one leg of the atomic new-account db.batch() in finishRegistration (src/auth/webauthn.ts). */
function buildCreateAccountStatement(
  db: D1Database,
  account: { id: string; displayName: string; createdAt: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO accounts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(account.id, account.displayName, account.createdAt, account.createdAt);
}

export async function createAccount(
  db: D1Database,
  account: { id: string; displayName: string; createdAt: string },
): Promise<void> {
  await buildCreateAccountStatement(db, account).run();
}

/** Physically removes an account row (ON DELETE CASCADE also removes any credentials/sessions it picked up) — only used to unwind a new-account registration whose db.batch() failed partway in a way that itself didn't roll back (see finishRegistration's post-batch invite-race cleanup). */
export async function deleteAccountById(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id).run();
}

export async function getAccountById(db: D1Database, id: string): Promise<Account | null> {
  const row = await db
    .prepare(`SELECT id, display_name FROM accounts WHERE id = ?`)
    .bind(id)
    .first<{ id: string; display_name: string }>();
  return row !== null ? { id: row.id, displayName: row.display_name } : null;
}

export interface CredentialRecord {
  id: string;
  accountId: string;
  /** base64url credential ID, matching WebAuthnCredential.id from @simplewebauthn. */
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: AuthenticatorTransportFuture[] | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface CredentialRow {
  id: string;
  account_id: string;
  credential_id: string;
  public_key: ArrayBuffer;
  sign_count: number;
  transports_json: string | null;
  device_type: string | null;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

function fromCredentialRow(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    credentialId: row.credential_id,
    publicKey: new Uint8Array(row.public_key),
    signCount: row.sign_count,
    transports:
      row.transports_json !== null
        ? (JSON.parse(row.transports_json) as AuthenticatorTransportFuture[])
        : null,
    deviceType: row.device_type,
    backedUp: row.backed_up !== 0,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Copies a Uint8Array's exact bytes into a fresh ArrayBuffer, safe to bind to a D1 BLOB column even when the view is a subarray of a larger buffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export interface NewCredential {
  id: string;
  accountId: string;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: AuthenticatorTransportFuture[] | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
}

/** Builds (without running) the webauthn_credentials INSERT statement — shared by insertCredential and the atomic new-account db.batch() in finishRegistration (src/auth/webauthn.ts). */
function buildInsertCredentialStatement(db: D1Database, cred: NewCredential): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO webauthn_credentials
         (id, account_id, credential_id, public_key, sign_count, transports_json, device_type, backed_up, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      cred.id,
      cred.accountId,
      cred.credentialId,
      toArrayBuffer(cred.publicKey),
      cred.signCount,
      cred.transports !== null ? JSON.stringify(cred.transports) : null,
      cred.deviceType,
      cred.backedUp ? 1 : 0,
      cred.createdAt,
    );
}

/** Inserts a new webauthn_credentials row. Throws (D1 UNIQUE violation) if credentialId is already registered to any account — callers must catch and translate. */
export async function insertCredential(db: D1Database, cred: NewCredential): Promise<void> {
  await buildInsertCredentialStatement(db, cred).run();
}

export async function findCredentialByCredentialId(
  db: D1Database,
  credentialId: string,
): Promise<CredentialRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, account_id, credential_id, public_key, sign_count, transports_json, device_type, backed_up, created_at, last_used_at
       FROM webauthn_credentials WHERE credential_id = ?`,
    )
    .bind(credentialId)
    .first<CredentialRow>();
  return row !== null ? fromCredentialRow(row) : null;
}

/** Every credential registered to an account — used to build excludeCredentials when registering an additional passkey (plan §16 recommends supporting multiple passkeys). */
export async function listCredentialsForAccount(
  db: D1Database,
  accountId: string,
): Promise<CredentialRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, account_id, credential_id, public_key, sign_count, transports_json, device_type, backed_up, created_at, last_used_at
       FROM webauthn_credentials WHERE account_id = ?`,
    )
    .bind(accountId)
    .all<CredentialRow>();
  return result.results.map(fromCredentialRow);
}

/**
 * Atomically deletes one webauthn_credentials row, scoped to accountId
 * (plan §16 — an account can only ever delete its own credential), while
 * refusing to ever leave the account with zero passkeys (登録モード仕様
 * Phase1 §5.6 "最後の1本は削除不可"). The "at least one other credential
 * remains" check is folded into the DELETE's WHERE clause as a correlated
 * subquery so the whole read-decide-write is one atomic SQL statement
 * instead of a separate count-then-delete — see PHASE1_REVIEW.md §High:
 * a caller-side `listCredentialsForAccount` count check before calling
 * this was a TOCTOU race where two concurrent deletes could each read the
 * same pre-delete count, both pass, and empty the account's passkeys,
 * locking it out of this WebAuthn-only (no password/email fallback)
 * service. Because D1/SQLite serializes statement execution, whichever of
 * two concurrent callers' DELETEs actually runs second always evaluates
 * the subquery against the first one's already-applied result.
 *
 * Returns false both when the credential doesn't exist for this account
 * and when it does but is the account's last one — callers that need to
 * tell those two apart for their HTTP response (routes.ts: 404 vs 409)
 * should follow up with the read-only credentialExistsForAccount() below;
 * a plain read can't itself race, only the read-decide-write combination
 * this function replaces could.
 */
export async function deleteCredentialById(db: D1Database, accountId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM webauthn_credentials
       WHERE id = ? AND account_id = ?
         AND (SELECT COUNT(*) FROM webauthn_credentials WHERE account_id = ?) > 1`,
    )
    .bind(id, accountId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Read-only existence check used by routes.ts after a failed
 * deleteCredentialById() to distinguish "credential not found/not owned"
 * (404) from "credential exists but is the account's last passkey" (409).
 * Safe to call after the fact — a plain SELECT cannot race with anything,
 * unlike the count-then-delete pattern deleteCredentialById replaced.
 */
export async function credentialExistsForAccount(db: D1Database, accountId: string, id: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM webauthn_credentials WHERE id = ? AND account_id = ? LIMIT 1`)
    .bind(id, accountId)
    .first();
  return row !== null;
}

/** Updates a credential's signCount and last_used_at after a successful login verification (replay-attack detection relies on the stored counter only ever increasing). */
export async function updateCredentialAfterLogin(
  db: D1Database,
  credentialId: string,
  newSignCount: number,
  lastUsedAt: string,
): Promise<void> {
  await db
    .prepare(`UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?`)
    .bind(newSignCount, lastUsedAt, credentialId)
    .run();
}

export interface InviteRecord {
  id: string;
  expiresAt: string;
  consumedAt: string | null;
}

/**
 * Pure eligibility check for a registration invite, unit-testable without
 * D1 (see test/auth-repository.test.ts): usable iff not already consumed
 * and not past its expiry.
 */
export function isInviteUsable(invite: Pick<InviteRecord, "consumedAt" | "expiresAt">, nowMs: number): boolean {
  if (invite.consumedAt !== null) {
    return false;
  }
  return new Date(invite.expiresAt).getTime() > nowMs;
}

export async function findInviteByTokenHash(db: D1Database, tokenHash: string): Promise<InviteRecord | null> {
  const row = await db
    .prepare(`SELECT id, expires_at, consumed_at FROM registration_invites WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<{ id: string; expires_at: string; consumed_at: string | null }>();
  return row !== null ? { id: row.id, expiresAt: row.expires_at, consumedAt: row.consumed_at } : null;
}

/** Builds (without running) the invite-consumption UPDATE statement — shared by consumeInvite and the atomic new-account db.batch() in finishRegistration (src/auth/webauthn.ts). */
function buildConsumeInviteStatement(db: D1Database, id: string, consumedAt: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE registration_invites SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(consumedAt, id);
}

/** Atomically marks an invite consumed; returns false if it was already consumed (caller must treat that as a conflict, not silently proceed). */
export async function consumeInvite(db: D1Database, id: string, consumedAt: string): Promise<boolean> {
  const result = await buildConsumeInviteStatement(db, id, consumedAt).run();
  return (result.meta.changes ?? 0) > 0;
}

export interface NewAccountRegistrationBatchResult {
  /** false iff the invite had already been consumed by a concurrent request — caller must then undo the account+credential rows this same batch just committed (D1 batch() has no way to make a later statement conditional on an earlier one's affected-row count, so that undo happens as a separate follow-up call). */
  inviteConsumed: boolean;
}

/**
 * Atomically runs invite consumption + account creation + credential
 * insertion as one D1 batch() (a single transaction): if the credential
 * insert fails (e.g. a UNIQUE violation because that passkey is already
 * registered elsewhere), the *entire* batch rolls back, so neither the
 * invite nor the account is left behind — closing the orphan-account gap
 * (invite consumed + account row with zero credentials, unusable) that
 * running these as separate calls had. The one thing D1 batch() cannot do is
 * make the account/credential inserts conditional on the invite UPDATE
 * actually having matched a row; batch() only rolls back on a thrown error,
 * and "0 rows updated" from a WHERE clause is not an error. So this can
 * still commit an account+credential pair for an invite that a concurrent
 * request consumed a moment earlier — inviteConsumed reports that (via the
 * first statement's affected-row count) so the caller can clean up.
 */
export async function runNewAccountRegistrationBatch(
  db: D1Database,
  params: {
    invite: { id: string; consumedAt: string };
    account: { id: string; displayName: string; createdAt: string };
    credential: NewCredential;
  },
): Promise<NewAccountRegistrationBatchResult> {
  const [inviteResult] = await db.batch([
    buildConsumeInviteStatement(db, params.invite.id, params.invite.consumedAt),
    buildCreateAccountStatement(db, params.account),
    buildInsertCredentialStatement(db, params.credential),
  ]);
  return { inviteConsumed: (inviteResult.meta.changes ?? 0) > 0 };
}
