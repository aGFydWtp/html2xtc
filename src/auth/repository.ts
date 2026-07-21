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

export async function createAccount(
  db: D1Database,
  account: { id: string; displayName: string; createdAt: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO accounts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(account.id, account.displayName, account.createdAt, account.createdAt)
    .run();
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

/** Inserts a new webauthn_credentials row. Throws (D1 UNIQUE violation) if credentialId is already registered to any account — callers must catch and translate. */
export async function insertCredential(db: D1Database, cred: NewCredential): Promise<void> {
  await db
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
    )
    .run();
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

/** Atomically marks an invite consumed; returns false if it was already consumed (caller must treat that as a conflict, not silently proceed). */
export async function consumeInvite(db: D1Database, id: string, consumedAt: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE registration_invites SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(consumedAt, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
