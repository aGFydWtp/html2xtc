// SPDX-License-Identifier: AGPL-3.0-or-later
// device-profiles.ts の出力解像度は src/devices.ts の DEVICE_PROFILES
// （outputWidthPx/outputHeightPx）の意図的な複製（frontend は src/ を import
// できないため — frontend/tsconfig.json の baseUrl/paths がリポジトリルート外を
// 指せない構成になっており、これはこの2ディレクトリを分離する意図的な境界。
// device-profiles.ts 冒頭のコメント参照）。
//
// この複製がズレると、ローカルプレビュー（pdf-preview.ts）だけが実際の変換結果
// と異なる解像度で描画されてしまい、気づきにくい。値そのものをここに書き写して
// 固定し、対応するバックエンド側の期待値（test/devices.test.ts の
// "DEVICE_PROFILES" describe ブロック、DEVICE_PROFILES.x3/x4.outputWidthPx/
// outputHeightPx への expect）と揃えておく。どちらか一方の値だけを変更すると
// 対応するテストが落ちる — 直接のクロスチェックではないが、変更時に両方揃える
// ことを強制する canary として機能する。
import { describe, expect, it } from "vitest";
import { outputSizeForDevice } from "../src/lib/device-profiles";

describe("outputSizeForDevice", () => {
  it("matches src/devices.ts's X3_PROFILE (see test/devices.test.ts)", () => {
    expect(outputSizeForDevice("x3")).toEqual({ widthPx: 528, heightPx: 792 });
  });

  it("matches src/devices.ts's X4_PROFILE (see test/devices.test.ts)", () => {
    expect(outputSizeForDevice("x4")).toEqual({ widthPx: 480, heightPx: 800 });
  });
});
