-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 aGFydWtp

-- X4 対応: library_items に「どのデバイス向けに変換したか」を記録する。
--
-- 目的は将来の警告機能（X3 実機に X4 サイズのファイルを送ろうとしたら警告
-- する）だが、判定ロジックそのものは本マイグレーションの範囲外。ここで先に
-- カラムだけ入れておくのは、記録が始まる前に変換された行を後から復元できな
-- いため。X4 変換をリリースしてから追加すると、その期間の行は X3/X4 が混在
-- した状態で判別不能になり、R2 の XTC 実体（ページヘッダの width/height）を
-- 全件開いて読むしか手が無くなる。
--
-- width/height と device を両方持つのは冗長ではなく、意味が違うため。
--   - width/height: 変換時に適用した解像度。その行にとって不変の値。
--   - device:       変換時に指定したプロファイル名。来歴。
-- ここで言う width/height は「Python 側が生成した XTC を測定した実測値」では
-- なく、変換時点の src/devices.ts のプロファイル値を書き込んだもの。実際の
-- ラスタライズは converter/config-*.toml が決めており、この2つは手動同期され
-- る別々の真実の源である点に注意（ズレた場合、変換結果そのものが壊れるので
-- 本カラムの正確さ以前の問題になる）。
-- それでも device 名ではなく解像度を判定に使う理由は以下のとおり。
-- device だけだと、その行の意味が「変換時の x4」ではなく「"現在の"
-- src/devices.ts が定義する x4」になってしまう（可変参照）。将来
-- converter/config-x4.toml の値を調整した瞬間、過去の行が黙って別の意味に
-- 変わる。逆に device を捨てて解像度だけにすると、プロファイルが将来マージン
-- やフォント指定でも分岐するようになったときに組版の根拠を追えなくなる。
--
-- 互換性の判定に使うのは device 名ではなく width/height の一致であること。
-- 同一解像度の新機種が出た場合、その端末には既存ファイルをそのまま送れるの
-- が正しく、名前で比較すると誤警告になる。この設計により、デバイスが増えて
-- も src/devices.ts にプロファイルを足すだけで済み、本スキーマと判定ロジック
-- は変更不要。
--
-- 既存行のバックフィル値が事実として正しい根拠: 本マイグレーション以前に
-- 存在した変換経路は X3 のみ（converter/config-x3.toml 単独、@page 66mm×99mm
-- ＝ 528×792px）。したがって既存の全行が 'x3' / 528 / 792 で確定する。
--
-- 対になる devices 側の機種カラム（次フェーズ）は、ここと違って NOT NULL
-- DEFAULT にしてはならない。既にペアリング済みの端末が X3 である保証はどこに
-- も無く、デフォルトで埋めると「不明」を「確認済み」に偽装してしまい、X4 実機
-- に X4 ファイルを送ったときに誤警告が出る。NULL 許容とし、NULL の間は警告を
-- 出さない方針とする。

ALTER TABLE library_items ADD COLUMN device TEXT NOT NULL DEFAULT 'x3';
ALTER TABLE library_items ADD COLUMN width INTEGER NOT NULL DEFAULT 528;
ALTER TABLE library_items ADD COLUMN height INTEGER NOT NULL DEFAULT 792;
