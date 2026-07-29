// SPDX-License-Identifier: AGPL-3.0-or-later
// 端末管理・端末別配信リスト・ペアリング承認（実装計画 §9.3 / §9.4）。

import { apiGet, apiSend, ApiError } from "./api";

export interface Device {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  lastSeenAt: string | null;
  /**
   * Machine-declared model/resolution from pairing
   * (migrations/app/0006_pairing_declared_device.sql). null means unknown —
   * a device paired before this field existed, or by firmware that never
   * declared one — and must NOT be treated as any particular model; the
   * resolution-mismatch warning (resolution-mismatch.ts) skips null.
   */
  device: string | null;
  width: number | null;
  height: number | null;
  /**
   * How the device was registered (Phase 2 §7/§8.3): "pairing" is the existing
   * QR-based firmware pairing flow, "manual_opds" is a standard OPDS client
   * registered by hand (createManualOpdsDevice()). Defaults to "pairing" when
   * the server omits the field so older/mismatched server responses degrade
   * safely instead of dropping the device from the list.
   */
  registrationMethod: "pairing" | "manual_opds";
}

export interface OpdsCredentials {
  serverName: string;
  catalogUrl: string;
  username: string;
  password: string;
}

export interface DeviceLibraryItem {
  id: string;
  title: string;
  author: string | null;
  sizeBytes: number;
  position: number;
  addedAt: string;
}

export interface DeviceLibrary {
  version: number;
  items: DeviceLibraryItem[];
}

export interface PairingLookup {
  pairingId: string;
  requestedName: string | null;
  expiresAt: string;
}

interface DevicesResponse {
  devices?: unknown;
}
interface DeviceResponse {
  device?: unknown;
}

function parseDevice(raw: unknown): Device | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string"
    || typeof r.name !== "string"
    || typeof r.status !== "string"
    || typeof r.createdAt !== "string"
  ) return null;
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    lastSeenAt: typeof r.lastSeenAt === "string" ? r.lastSeenAt : null,
    device: typeof r.device === "string" ? r.device : null,
    width: typeof r.width === "number" ? r.width : null,
    height: typeof r.height === "number" ? r.height : null,
    registrationMethod: r.registrationMethod === "manual_opds" ? "manual_opds" : "pairing",
  };
}

function parseOpdsCredentials(raw: unknown): OpdsCredentials | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.serverName !== "string"
    || typeof r.catalogUrl !== "string"
    || typeof r.username !== "string"
    || typeof r.password !== "string"
  ) return null;
  return { serverName: r.serverName, catalogUrl: r.catalogUrl, username: r.username, password: r.password };
}

function parseDevices(raw: unknown): Device[] {
  if (!Array.isArray(raw)) return [];
  const out: Device[] = [];
  for (const x of raw) {
    const d = parseDevice(x);
    if (d) out.push(d);
  }
  return out;
}

function parseDeviceLibraryItem(raw: unknown): DeviceLibraryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string"
    || typeof r.title !== "string"
    || typeof r.sizeBytes !== "number"
    || typeof r.position !== "number"
    || typeof r.addedAt !== "string"
  ) return null;
  return {
    id: r.id,
    title: r.title,
    author: typeof r.author === "string" ? r.author : null,
    sizeBytes: r.sizeBytes,
    position: r.position,
    addedAt: r.addedAt,
  };
}

function parseDeviceLibrary(raw: unknown): DeviceLibrary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "number" || !Array.isArray(r.items)) return null;
  const items: DeviceLibraryItem[] = [];
  for (const x of r.items) {
    const item = parseDeviceLibraryItem(x);
    if (item) items.push(item);
  }
  return { version: r.version, items };
}

function parsePairingLookup(raw: unknown): PairingLookup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pairingId !== "string" || typeof r.expiresAt !== "string") return null;
  return {
    pairingId: r.pairingId,
    requestedName: typeof r.requestedName === "string" ? r.requestedName : null,
    expiresAt: r.expiresAt,
  };
}

export type ReplaceLibraryResult =
  | { ok: true; library: DeviceLibrary }
  | { ok: false; conflict: boolean };

export interface CreateManualOpdsDeviceInput {
  name: string;
  deviceModel?: "x3" | "x4" | "other" | null;
  width?: number;
  height?: number;
}

// code は ApiError.code をそのまま透過する（呼び出し元がエラーコードごとの
// 文言を出し分けられるようにするため、既存の boolean 戻り値パターンでは足りない）。
export type CreateManualOpdsDeviceResult =
  | { ok: true; device: Device; opds: OpdsCredentials }
  | { ok: false; code: string | null };

export type RotateDeviceTokenResult =
  | { ok: true; opds: OpdsCredentials }
  | { ok: false; code: string | null };

class DevicesStore {
  devices = $state<Device[]>([]);
  loadState = $state<"idle" | "loading" | "loaded" | "fail">("idle");

  /** load() の重複発火防止（タブ連打などでのリクエスト多重化を避ける）。 */
  #loadInFlight = false;

  /**
   * 一覧を取得する。初回（loadState が idle/fail）はローディング表示を出すが、
   * 既に loaded の場合は既存の一覧を表示したまま裏で再取得し、完了時に
   * 差し替える（タブ再表示時のチラつき防止）。再取得の失敗は既存データを
   * 残して静かに握りつぶす（store 内の他の更新系と同じ流儀）。
   */
  async load(): Promise<void> {
    if (this.#loadInFlight) return;
    this.#loadInFlight = true;
    const isRefresh = this.loadState === "loaded";
    if (!isRefresh) this.loadState = "loading";
    try {
      const body = await apiGet<DevicesResponse>("/api/devices");
      this.devices = parseDevices(body.devices);
      this.loadState = "loaded";
    } catch {
      if (!isRefresh) this.loadState = "fail";
    } finally {
      this.#loadInFlight = false;
    }
  }

  async rename(deviceId: string, name: string): Promise<boolean> {
    try {
      const body = await apiSend<DeviceResponse>("PATCH", `/api/devices/${encodeURIComponent(deviceId)}`, { name });
      const device = parseDevice(body.device);
      if (!device) return false;
      this.devices = this.devices.map((d) => (d.id === device.id ? device : d));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 標準 OPDS 端末を手動登録する（Phase 2 §8.1）。opds.password は呼び出し元
   * （接続情報ダイアログ）へ戻り値として渡すだけで、ここでも呼び出し元でも
   * 永続 state / localStorage / sessionStorage には保存しない（§11 セキュリティ要件）。
   * 新規端末は作成日時降順（サーバーの一覧クエリと同じ並び）で先頭に足す。
   */
  async createManualOpdsDevice(input: CreateManualOpdsDeviceInput): Promise<CreateManualOpdsDeviceResult> {
    try {
      const payload: Record<string, unknown> = { name: input.name };
      if (input.deviceModel !== undefined) payload.deviceModel = input.deviceModel;
      if (input.width !== undefined) payload.width = input.width;
      if (input.height !== undefined) payload.height = input.height;
      const body = await apiSend<{ device?: unknown; opds?: unknown }>("POST", "/api/devices/manual-opds", payload);
      const device = parseDevice(body.device);
      const opds = parseOpdsCredentials(body.opds);
      if (!device || !opds) return { ok: false, code: null };
      this.devices = [device, ...this.devices];
      return { ok: true, device, opds };
    } catch (e) {
      return { ok: false, code: e instanceof ApiError ? e.code : null };
    }
  }

  /**
   * 接続情報（token）を再発行する（Phase 2 §8.2）。成功レスポンスの device は
   * {id,name,status} のみで一覧表示に必要な項目（device/width/height/
   * registrationMethod 等）を含まないため、この一覧 (this.devices) は書き換え
   * ない — rotation は表示中の項目を変えないので更新の必要がない。
   */
  async rotateDeviceToken(deviceId: string): Promise<RotateDeviceTokenResult> {
    try {
      const body = await apiSend<{ opds?: unknown }>("POST", `/api/devices/${encodeURIComponent(deviceId)}/rotate-token`);
      const opds = parseOpdsCredentials(body.opds);
      if (!opds) return { ok: false, code: null };
      return { ok: true, opds };
    } catch (e) {
      return { ok: false, code: e instanceof ApiError ? e.code : null };
    }
  }

  async revoke(deviceId: string): Promise<boolean> {
    try {
      await apiSend("DELETE", `/api/devices/${encodeURIComponent(deviceId)}`);
      await this.load();
      return true;
    } catch {
      return false;
    }
  }

  async getLibrary(deviceId: string): Promise<DeviceLibrary | null> {
    try {
      const body = await apiGet<unknown>(`/api/devices/${encodeURIComponent(deviceId)}/library`);
      return parseDeviceLibrary(body);
    } catch {
      return null;
    }
  }

  async replaceLibrary(deviceId: string, expectedVersion: number, itemIds: string[]): Promise<ReplaceLibraryResult> {
    try {
      const body = await apiSend<unknown>("PUT", `/api/devices/${encodeURIComponent(deviceId)}/library`, {
        expectedVersion,
        itemIds,
      });
      const library = parseDeviceLibrary(body);
      if (!library) return { ok: false, conflict: false };
      return { ok: true, library };
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      return { ok: false, conflict };
    }
  }

  /**
   * 対象端末の配信リスト先頭に itemIds を追加する（既に載っているものはスキップ）。
   * 新しく追加した分が一番上に来るよう、itemIds はその並び順のまま existing の前に置く
   * （呼び出し元は itemIds を「新しいものが先頭」の順で渡すこと）。
   * 全件が既載なら PUT を送らず成功扱い（冪等）。バージョン競合（409）は最新を
   * 再取得して 1 回だけ再試行する。
   */
  async addItemsToDevice(deviceId: string, itemIds: string[]): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const lib = await this.getLibrary(deviceId);
      if (!lib) return false;
      const existing = lib.items.slice().sort((a, b) => a.position - b.position).map((i) => i.id);
      const toAdd = itemIds.filter((id) => !existing.includes(id));
      if (toAdd.length === 0) return true;
      const result = await this.replaceLibrary(deviceId, lib.version, [...toAdd, ...existing]);
      if (result.ok) return true;
      if (!result.conflict) return false;
      // 409: 他の画面で更新された → 最新版で再試行
    }
    return false;
  }

  async lookupPairing(userCode: string): Promise<PairingLookup | null> {
    try {
      const body = await apiGet<unknown>(`/api/pairings/by-code/${encodeURIComponent(userCode)}`);
      return parsePairingLookup(body);
    } catch {
      return null;
    }
  }

  async approvePairing(pairingId: string, name: string): Promise<boolean> {
    try {
      await apiSend("POST", `/api/pairings/${encodeURIComponent(pairingId)}/approve`, { name });
      await this.load();
      return true;
    } catch {
      return false;
    }
  }

  async rejectPairing(pairingId: string): Promise<boolean> {
    try {
      await apiSend("POST", `/api/pairings/${encodeURIComponent(pairingId)}/reject`, {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clears cached state so the next login re-fetches from scratch — same
   * rationale as libraryStore.reset() (frontend/src/lib/library.svelte.ts),
   * called by authStore on logout and on every successful login/register.
   */
  reset(): void {
    this.devices = [];
    this.loadState = "idle";
  }
}

export const devicesStore = new DevicesStore();
