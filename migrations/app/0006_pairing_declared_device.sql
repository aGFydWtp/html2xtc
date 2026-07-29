-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 aGFydWtp

-- crosspoint-jp（端末ファーム）が POST /api/device-pairings のボディに
-- deviceModel/width/height を申告するようになった（旧ファームは送らない）。
-- ここではその申告値を素通しで保存するだけの列を追加する。この3列は
-- device_pairings 側が中継用、devices 側が本番用で、承認時
-- (approvePairingForAccount, src/devices/pairings.ts) にそのままコピーされる。
--
-- 解像度はポートレート正規化済み（短辺=width）でファームから送られてくる
-- 前提。library_items（0005）に倣い、device 名ではなく width/height の一致で
-- 互換性を判定する方針は変わらない。列名を device/width/height に揃えている
-- のは、将来「X3 端末に X4 サイズのファイルを送ろうとしたら警告」を
-- library_items.device/width/height と対称なロジックで書けるようにするため。
--
-- 全列 NULL 許容・DEFAULT なしとする理由（0005 が devices 側について既に
-- 予告していた内容そのもの）:
--   - 旧ファームでペアリング済みの端末は、実際には X4 でも申告が無いだけで
--     X3 と断定できる根拠は無い。NOT NULL DEFAULT 'x3' のようにすると
--     「不明」を「確認済みX3」に偽装してしまい、後で X4 実機に X4 ファイルを
--     送ったときに誤警告が出る。
--   - width/height も同様。片方だけ・不正値のときは両方 NULL にして
--     「解像度不明」を表現する（正規化ロジック側の責務）。
--   - NULL = 機種/解像度不明 = 警告を出さない、が本カラムのセマンティクス。
--     library_items.device/width/height（0005）が「変換時点の実測値として
--     常に確定している」のと違い、こちらは「端末が申告してきた値をそのまま
--     転記しただけ」で、申告が無い/壊れているケースを NULL 以外で表現する
--     手段が無い。

ALTER TABLE device_pairings ADD COLUMN requested_device TEXT;
ALTER TABLE device_pairings ADD COLUMN requested_width INTEGER;
ALTER TABLE device_pairings ADD COLUMN requested_height INTEGER;

ALTER TABLE devices ADD COLUMN device TEXT;
ALTER TABLE devices ADD COLUMN width INTEGER;
ALTER TABLE devices ADD COLUMN height INTEGER;
