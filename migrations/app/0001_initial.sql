-- APP_DB initial schema: accounts, passkey/session auth, devices, pairings,
-- and the persistent library. Separate from AOZORA_DB (catalog data) so
-- catalog re-syncs can never touch user data. Tables and indexes match the
-- implementation plan §7.1 verbatim; see
-- /Users/haruki/Downloads/html2xtc-device-library-implementation-plan.md.
--
-- Phase 0/1 (this migration) only wires up accounts + library_items for the
-- session/library groundwork; webauthn_credentials, auth_challenges,
-- registration_invites, devices, device_pairings, and device_library_items
-- are created now too (so later phases don't need a schema-churning
-- migration) but are not yet populated by any route in this phase.

PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  account_id TEXT,
  challenge_hash TEXT NOT NULL,
  metadata_json TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE registration_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  library_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_devices_account
  ON devices(account_id, status);

CREATE TABLE device_pairings (
  id TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  pairing_secret_hash TEXT NOT NULL,
  requested_name TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'expired')),
  account_id TEXT,
  device_id TEXT,
  encrypted_device_token BLOB,
  token_iv BLOB,
  token_auth_tag BLOB,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE INDEX idx_pairings_code
  ON device_pairings(user_code, status, expires_at);

CREATE TABLE library_items (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_job_id TEXT,
  source_url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_library_items_account
  ON library_items(account_id, deleted_at, created_at);

CREATE TABLE device_library_items (
  device_id TEXT NOT NULL,
  library_item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (device_id, library_item_id),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (library_item_id) REFERENCES library_items(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_device_library_position
  ON device_library_items(device_id, position);
