-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 aGFydWtp

-- 登録モード仕様 Phase 2 (open): 公開登録（招待なし新規登録）で必要になる
-- 2テーブル。
--   - account_terms_acceptances: 規約/プライバシー同意のバージョン履歴。
--     アカウント削除時は ON DELETE CASCADE で連動削除する（他のアカウント
--     スコープテーブル — sessions, webauthn_credentials, library_items,
--     devices — と同じ方針、migrations/app/0001_initial.sql 参照）。
--   - registration_events: 日次/IP別の新規登録レート制限用カウンタ材料。
--     生IPは保存せず、REGISTRATION_IP_PEPPER で HMAC 相当のハッシュ化した
--     ip_hash のみを保存する（登録モード仕様 Phase2 §4b）。7日保持
--     （src/db/cleanup.ts の既存パターンで cron 削除対象に追加する）。

PRAGMA foreign_keys = ON;

CREATE TABLE account_terms_acceptances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_terms_acceptances_account
  ON account_terms_acceptances(account_id);

CREATE TABLE registration_events (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 日次/IP別カウント集計（WHERE ip_hash = ? AND status = 'succeeded' AND
-- created_at >= ?）と cleanup.ts の期限削除（WHERE expires_at < ?）の両方を
-- カバーする複合インデックス。
CREATE INDEX idx_registration_events_ip_created
  ON registration_events(ip_hash, created_at);

CREATE INDEX idx_registration_events_expires
  ON registration_events(expires_at);
