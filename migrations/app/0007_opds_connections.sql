-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 aGFydWtp

-- Generic OPDS connection storage (汎用OPDS基盤＋Memlane EPUB取り込み機能
-- 実装仕様書 §10). Deliberately NOT "memlane_connections" — the initial
-- release only ever creates one row per account with provider='memlane', but
-- the schema itself is provider-agnostic so a future generic-OPDS UI can
-- reuse this table without another migration (spec §28).
--
-- Every credential-bearing column is stored as separate ciphertext/iv/
-- auth_tag BLOBs (AES-256-GCM, src/integrations/opds/connection-crypto.ts) —
-- never plaintext, per spec §10.1's "常に暗号化: catalog URL" (the URL alone
-- can be a bearer secret for authType="url_secret") and "Basic認証の場合のみ
-- 暗号化: username / password". The username/password columns are nullable
-- because they simply don't exist for authType IN ('none','url_secret').
--
-- FOREIGN KEY ... ON DELETE CASCADE: the spec's own §10 DDL omits this, but
-- every other per-account table in this schema (webauthn_credentials,
-- sessions, devices, ...) cascades on account deletion, and a dangling
-- encrypted-credential row surviving its owner's account deletion is a worse
-- outcome than losing it — deliberate deviation from the spec text to match
-- this codebase's existing convention (登録モード仕様 account deletion, 0001).
--
-- idx_opds_connections_account_provider_name (UNIQUE): backs the "1
-- account + 1 Memlane connection" rule (spec §10, "service層でaccountId +
-- provider=memlaneをupsert対象にする") without a second round-trip — the
-- create/replace path (src/integrations/opds/repository.ts) always deletes
-- any existing (account_id, provider, name) row before inserting the new
-- one in the same D1 batch(), so this index's role is defense-in-depth
-- against a concurrent double-create racing the same replace, not the
-- primary mechanism.

PRAGMA foreign_keys = ON;

CREATE TABLE opds_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_type TEXT NOT NULL,

  catalog_url_ciphertext BLOB NOT NULL,
  catalog_url_iv BLOB NOT NULL,
  catalog_url_auth_tag BLOB NOT NULL,

  username_ciphertext BLOB,
  username_iv BLOB,
  username_auth_tag BLOB,

  password_ciphertext BLOB,
  password_iv BLOB,
  password_auth_tag BLOB,

  origin TEXT NOT NULL,
  host TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,

  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_opds_connections_account
  ON opds_connections(account_id);

CREATE UNIQUE INDEX idx_opds_connections_account_provider_name
  ON opds_connections(account_id, provider, name);
