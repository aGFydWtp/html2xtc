// SPDX-License-Identifier: AGPL-3.0-or-later
// Xteink 機種ごとの出力解像度（px）。src/devices.ts の DEVICE_PROFILES
// （outputWidthPx/outputHeightPx）と対応する値のみをフロントエンド側で複製
// している — frontend は src/ を import できないため（text-options.ts の
// FONT_FAMILY_RE 複製と同じ理由）。アップロード前ローカルプレビュー
// （pdf-preview.ts）の描画サイズにのみ使う。変更時は両方揃えること。

import type { Device } from "./device-tag";

export interface DeviceOutputSize {
  widthPx: number;
  heightPx: number;
}

const DEVICE_OUTPUT_SIZES: Readonly<Record<Device, DeviceOutputSize>> = {
  x3: { widthPx: 528, heightPx: 792 },
  x4: { widthPx: 480, heightPx: 800 },
};

export function outputSizeForDevice(device: Device): DeviceOutputSize {
  return DEVICE_OUTPUT_SIZES[device];
}
