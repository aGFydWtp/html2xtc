// SPDX-License-Identifier: AGPL-3.0-or-later
// 端末とライブラリ項目の解像度ミスマッチ判定（X3/X4 混在対応、警告のみでブロックはしない）。
//
// 比較キーは device 文字列（"x3"/"x4"）ではなく width/height。機種が増えても
// このロジックを変えずに済み、XTC ファイル内の実値とも後から素直に照合できる
// （migrations/app/0006_pairing_declared_device.sql の設計意図）。
//
// 両辺ともポートレート正規化済み（短辺 = width）という前提で単純比較している:
// 端末側（devices.width/height）はペアリング申告値がポートレート正規化済み、
// ライブラリ項目側（library_items.width/height）は変換時に適用した静的
// プロファイル値で同じくポートレート正規化済み。将来 landscape 申告が来る
// ようになった場合はこの前提が崩れるので、その時はここを見直すこと。

export interface Resolution {
  width: number | null;
  height: number | null;
}

/**
 * 解像度が「食い違っている」と言えるか。どちらかが null（機種/解像度不明、
 * あるいは呼び出し元でメタが解決できなかった項目）なら警告なし（false）。
 * 両辺の値が揃っていて、かつ width か height のどちらかが異なる場合のみ true。
 */
export function isResolutionMismatch(a: Resolution, b: Resolution): boolean {
  if (a.width === null || a.height === null) return false;
  if (b.width === null || b.height === null) return false;
  return a.width !== b.width || a.height !== b.height;
}
