-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 aGFydWtp

-- Phase 2（本家 CrossPoint 等の標準 OPDS クライアントを WebUI から手動登録できるように
-- する機能、claudedocs/html2xtc-opds-phase2-spec.md）で、QR ペアリング以外の経路
-- （POST /api/devices/manual-opds）で devices 行が作られるようになる。この列は、その
-- 行が「端末からの QR ペアリングで作られたのか」「WebUI からの手動登録で作られたのか」を
-- 区別するためだけの識別用メタデータで、認証・認可のロジックには一切影響しない
-- （どちらの経路で作られた devices 行も、以降は同じ Basic 認証・OPDS・配信リスト・
-- revoke の仕組みで扱われる——仕様書 §3「登録後の操作は既存の端末連携と共通化する」）。
--
-- 許容値は 'pairing' | 'manual_opds' の2つのみ（アプリ側で検証・固定。DB 側の CHECK
-- 制約は付けない——device_pairings.status 等、他の enum 的列も同様の方針）。
--
-- 既存行（すべて QR ペアリング経由で作られたもの）を後から 'manual_opds' に誤分類しない
-- よう、NOT NULL DEFAULT 'pairing' とする——0005/0006 が device/width/height を NULL
-- 許容にした「不明を確定値に偽装しない」方針とは逆に、こちらは「過去の行の由来は
-- 疑いようがなく pairing である」ため、DEFAULT を安全側の実データとして使える。
ALTER TABLE devices ADD COLUMN registration_method TEXT NOT NULL DEFAULT 'pairing';
