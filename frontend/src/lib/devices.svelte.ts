// SPDX-License-Identifier: AGPL-3.0-or-later
// 端末管理・端末別配信リスト・ペアリング承認（実装計画 §9.3 / §9.4）。

import { apiGet, apiSend, ApiError } from "./api";

export interface Device {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  lastSeenAt: string | null;
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
interface RotatedResponse {
  deviceId?: unknown;
  deviceToken?: unknown;
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
  };
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

class DevicesStore {
  devices = $state<Device[]>([]);
  loadState = $state<"idle" | "loading" | "loaded" | "fail">("idle");

  async load(): Promise<void> {
    this.loadState = "loading";
    try {
      const body = await apiGet<DevicesResponse>("/api/devices");
      this.devices = parseDevices(body.devices);
      this.loadState = "loaded";
    } catch {
      this.loadState = "fail";
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

  async revoke(deviceId: string): Promise<boolean> {
    try {
      await apiSend("DELETE", `/api/devices/${encodeURIComponent(deviceId)}`);
      await this.load();
      return true;
    } catch {
      return false;
    }
  }

  /** 成功時は平文 deviceToken を一度だけ返す。サーバー側もハッシュのみ保持し、以後は取得不能。 */
  async rotateToken(deviceId: string): Promise<string | null> {
    try {
      const body = await apiSend<RotatedResponse>("POST", `/api/devices/${encodeURIComponent(deviceId)}/token`, {});
      return typeof body.deviceToken === "string" ? body.deviceToken : null;
    } catch {
      return null;
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
