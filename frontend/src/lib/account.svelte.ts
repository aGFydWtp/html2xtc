// SPDX-License-Identifier: AGPL-3.0-or-later
// アカウント画面（使用量・パスキー管理）の状態（登録モード仕様 Phase1 §5.9）。
// devices.svelte.ts と同じ「load()/loadState + parse 関数」の流儀。セッション一覧は
// authStore.loadSessions/revokeSession（既存・実装済み）をそのまま使うためここには
// 含めない。アカウント削除は identity を直接変更するため authStore 側の責務とする。

import { apiGet, apiSend, ApiError } from "./api";

export interface UsageMetric {
  used: number;
  limit: number;
}

export interface Usage {
  libraryItems: UsageMetric;
  libraryBytes: UsageMetric;
  devices: UsageMetric;
  sessions: UsageMetric;
  passkeys: UsageMetric;
}

export interface Passkey {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}

interface UsageResponse {
  libraryItems?: unknown;
  libraryBytes?: unknown;
  devices?: unknown;
  sessions?: unknown;
  passkeys?: unknown;
}
interface PasskeysResponse {
  passkeys?: unknown;
}

function parseMetric(raw: unknown): UsageMetric | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.used !== "number" || typeof r.limit !== "number") return null;
  return { used: r.used, limit: r.limit };
}

function parseUsage(raw: UsageResponse): Usage | null {
  const libraryItems = parseMetric(raw.libraryItems);
  const libraryBytes = parseMetric(raw.libraryBytes);
  const devices = parseMetric(raw.devices);
  const sessions = parseMetric(raw.sessions);
  const passkeys = parseMetric(raw.passkeys);
  if (!libraryItems || !libraryBytes || !devices || !sessions || !passkeys) return null;
  return { libraryItems, libraryBytes, devices, sessions, passkeys };
}

function parsePasskey(raw: unknown): Passkey | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.createdAt !== "string" || typeof r.backedUp !== "boolean") return null;
  return {
    id: r.id,
    createdAt: r.createdAt,
    lastUsedAt: typeof r.lastUsedAt === "string" ? r.lastUsedAt : null,
    backedUp: r.backedUp,
  };
}

function parsePasskeys(raw: unknown): Passkey[] {
  if (!Array.isArray(raw)) return [];
  const out: Passkey[] = [];
  for (const x of raw) {
    const p = parsePasskey(x);
    if (p) out.push(p);
  }
  return out;
}

/** 80%超で警告、100%以上で保存不可（登録モード仕様 Phase1 §5.9）。 */
export function usageRatio(metric: UsageMetric): number {
  if (metric.limit <= 0) return 0;
  return metric.used / metric.limit;
}
export function usageIsWarning(metric: UsageMetric): boolean {
  return usageRatio(metric) > 0.8 && usageRatio(metric) < 1;
}
export function usageIsFull(metric: UsageMetric): boolean {
  return usageRatio(metric) >= 1;
}

class AccountStore {
  usage = $state<Usage | null>(null);
  usageLoadState = $state<"idle" | "loading" | "loaded" | "fail">("idle");

  passkeys = $state<Passkey[]>([]);
  passkeysLoadState = $state<"idle" | "loading" | "loaded" | "fail">("idle");
  deletingPasskeyId = $state<string | null>(null);
  passkeyErrorCode = $state<string | null>(null);

  async loadUsage(): Promise<void> {
    this.usageLoadState = "loading";
    try {
      const body = await apiGet<UsageResponse>("/api/me/usage");
      const usage = parseUsage(body);
      if (!usage) {
        this.usageLoadState = "fail";
        return;
      }
      this.usage = usage;
      this.usageLoadState = "loaded";
    } catch {
      this.usageLoadState = "fail";
    }
  }

  async loadPasskeys(): Promise<void> {
    this.passkeysLoadState = "loading";
    try {
      const body = await apiGet<PasskeysResponse>("/api/me/passkeys");
      this.passkeys = parsePasskeys(body.passkeys);
      this.passkeysLoadState = "loaded";
    } catch {
      this.passkeysLoadState = "fail";
    }
  }

  async deletePasskey(id: string): Promise<boolean> {
    this.deletingPasskeyId = id;
    this.passkeyErrorCode = null;
    try {
      await apiSend("DELETE", `/api/me/passkeys/${encodeURIComponent(id)}`);
      this.passkeys = this.passkeys.filter((p) => p.id !== id);
      return true;
    } catch (e) {
      this.passkeyErrorCode = e instanceof ApiError ? (e.code ?? "UNKNOWN") : "UNKNOWN";
      return false;
    } finally {
      this.deletingPasskeyId = null;
    }
  }

  /** ログイン/ログアウトのたびに authStore.resetAccountScopedStores から呼ばれる。 */
  reset(): void {
    this.usage = null;
    this.usageLoadState = "idle";
    this.passkeys = [];
    this.passkeysLoadState = "idle";
    this.deletingPasskeyId = null;
    this.passkeyErrorCode = null;
  }
}

export const accountStore = new AccountStore();
