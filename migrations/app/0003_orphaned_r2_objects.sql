-- 登録モード仕様 Phase 1 §5.5 / gap analysis §3 案A: アカウント削除時に R2
-- オブジェクトの削除が失敗した場合の記録テーブル。D1側のアカウント削除
-- （accounts行のDELETE、ON DELETE CASCADEでcredentials/sessions/
-- library_items/devicesも連動削除）は R2削除の成否に関わらず完遂させる
-- 要件のため、既存の library_items.deleted_at のような「D1行を残して記録
-- 代わりにする」方式が使えず、この専用テーブルに孤児R2キーを記録する。
--
-- Phase 1では書き込みのみ（src/db/orphaned-r2.ts の recordOrphanedR2Object）。
-- 再削除バッチ（src/db/cleanup.ts 拡張）は後続フェーズで実装する。

PRAGMA foreign_keys = ON;

CREATE TABLE orphaned_r2_objects (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
