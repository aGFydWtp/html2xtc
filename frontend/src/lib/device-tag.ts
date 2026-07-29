// SPDX-License-Identifier: AGPL-3.0-or-later
// タイトル前に表示する機種タグ（X3/X4）の表示値決定。DOM/Svelte 非依存の純粋関数。

export type Device = "x3" | "x4";

/**
 * device 文字列（"x3" | "x4" | undefined | 未知の値）を、タグ表示用の Device へ
 * 正規化する。
 *
 * device が欠落しているのは、機種選択が存在しなかった時代の変換のみ（サーバーは
 * 取得できなかった場合に推測で埋めたりしない）。その時代の変換は必ず X3 だった
 * ため、欠落時は "x3" にフォールバックする。これは表示専用の判断であり、
 * 「情報が無い」と「x3 だった」をデータ上で同一視するものではない
 * （migrations/app/0005_library_item_device.sql が既存行を 'x3' でバックフィル
 * したのと同じ前提に基づく）。
 */
export function resolveDeviceTag(device?: string): Device {
  return device === "x4" ? "x4" : "x3";
}
