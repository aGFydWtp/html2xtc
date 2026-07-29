// SPDX-License-Identifier: AGPL-3.0-or-later
// 変換先 Xteink 機種（X3/X4）のトグル状態。src/devices.ts の DeviceId ドメイン
// （変換パイプラインが出力する画像の機種）と対応する — devices.svelte.ts の
// deviceModel（アカウントにペアリングされた実機の申告値）とは別ドメインなので
// 混同しないこと。
//
// 初期値は URL の ?device= から解決する。"x4" のときだけ x4、それ以外
// （欠落・不正値・"x3"）はすべて x3 にフォールバックする — src/devices.ts の
// resolveDeviceId と同じ fail-soft な既定値の取り方。
//
// 値を変更すると URL にも反映する（x4 なら ?device=x4 を付与、x3 なら
// パラメータを削除）。history.replaceState を使うため履歴エントリは増えない。
// ?register=/?pair=（App.svelte）と違い、読み取り後にパラメータを消費・削除
// する一回限りの値ではなく、ブックマーク可能な状態として URL に残し続ける。
// App.svelte の独自ルーター（selectTab 等）は遷移のたびに location.search を
// そのまま引き継ぐため、タブ切り替えでこのパラメータが失われることはない。

import type { Device } from "./device-tag";

function resolveDeviceFromSearch(search: string): Device {
  return new URLSearchParams(search).get("device") === "x4" ? "x4" : "x3";
}

function writeDeviceToUrl(device: Device): void {
  const params = new URLSearchParams(location.search);
  if (device === "x4") {
    params.set("device", "x4");
  } else {
    params.delete("device");
  }
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
}

class TargetDeviceStore {
  device = $state<Device>(
    typeof location === "undefined" ? "x3" : resolveDeviceFromSearch(location.search),
  );

  set(device: Device): void {
    if (this.device === device) return;
    this.device = device;
    writeDeviceToUrl(device);
  }
}

export const targetDeviceStore = new TargetDeviceStore();
