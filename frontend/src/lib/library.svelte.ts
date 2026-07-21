// SPDX-License-Identifier: AGPL-3.0-or-later
// マイライブラリ（永続保存された XTC 一覧、実装計画 §9.2）。

import { apiGet, apiSend } from "./api";

export interface LibraryItem {
  id: string;
  title: string;
  author: string | null;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ItemsResponse {
  items?: unknown;
}
interface ItemResponse {
  item?: unknown;
}

function parseItem(raw: unknown): LibraryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string"
    || typeof r.title !== "string"
    || typeof r.sizeBytes !== "number"
    || typeof r.createdAt !== "string"
    || typeof r.updatedAt !== "string"
  ) return null;
  return {
    id: r.id,
    title: r.title,
    author: typeof r.author === "string" ? r.author : null,
    sizeBytes: r.sizeBytes,
    sha256: typeof r.sha256 === "string" ? r.sha256 : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function parseItems(raw: unknown): LibraryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: LibraryItem[] = [];
  for (const x of raw) {
    const item = parseItem(x);
    if (item) out.push(item);
  }
  return out;
}

class LibraryStore {
  items = $state<LibraryItem[]>([]);
  loadState = $state<"idle" | "loading" | "loaded" | "fail">("idle");

  // POST /api/library/items/from-job で保存済みの jobId（このセッション内のみ、
  // ページ再読み込みでリセットされる — 再保存してもサーバー側の冪等性
  // (source_job_id) に任せるため実害はない）。
  savedJobIds = $state<Set<string>>(new Set());

  // saveFromJob 実行中 / 失敗した jobId。CurrentJob 行のテキスト表示
  // （保存中… / 保存に失敗しました）が自動保存の進行状態を参照するために持つ。
  savingJobIds = $state<Set<string>>(new Set());
  saveFailedJobIds = $state<Set<string>>(new Set());

  async load(): Promise<void> {
    this.loadState = "loading";
    try {
      const body = await apiGet<ItemsResponse>("/api/library/items");
      this.items = parseItems(body.items);
      this.loadState = "loaded";
    } catch {
      this.loadState = "fail";
    }
  }

  isSavedJob(jobId: string): boolean {
    return this.savedJobIds.has(jobId);
  }

  isSavingJob(jobId: string): boolean {
    return this.savingJobIds.has(jobId);
  }

  isSaveFailedJob(jobId: string): boolean {
    return this.saveFailedJobIds.has(jobId);
  }

  async saveFromJob(jobId: string, title?: string, author?: string): Promise<boolean> {
    this.savingJobIds = new Set(this.savingJobIds).add(jobId);
    if (this.saveFailedJobIds.has(jobId)) {
      const next = new Set(this.saveFailedJobIds);
      next.delete(jobId);
      this.saveFailedJobIds = next;
    }
    try {
      const body = await apiSend<ItemResponse>("POST", "/api/library/items/from-job", {
        jobId,
        ...(title ? { title } : {}),
        ...(author ? { author } : {}),
      });
      const item = parseItem(body.item);
      if (!item) {
        this.saveFailedJobIds = new Set(this.saveFailedJobIds).add(jobId);
        return false;
      }
      if (!this.items.some((i) => i.id === item.id)) this.items = [item, ...this.items];
      const next = new Set(this.savedJobIds);
      next.add(jobId);
      this.savedJobIds = next;
      return true;
    } catch {
      this.saveFailedJobIds = new Set(this.saveFailedJobIds).add(jobId);
      return false;
    } finally {
      const next = new Set(this.savingJobIds);
      next.delete(jobId);
      this.savingJobIds = next;
    }
  }

  async updateItem(itemId: string, patch: { title?: string; author?: string | null }): Promise<boolean> {
    try {
      const body = await apiSend<ItemResponse>("PATCH", `/api/library/items/${encodeURIComponent(itemId)}`, patch);
      const item = parseItem(body.item);
      if (!item) return false;
      this.items = this.items.map((i) => (i.id === item.id ? item : i));
      return true;
    } catch {
      return false;
    }
  }

  async deleteItem(itemId: string): Promise<boolean> {
    try {
      await apiSend("DELETE", `/api/library/items/${encodeURIComponent(itemId)}`);
      this.items = this.items.filter((i) => i.id !== itemId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clears cached state so the next login re-fetches from scratch. Called
   * by authStore on logout and on every successful login/register — without
   * this, a same-tab account switch would keep showing the previous
   * account's library (loadState stays "loaded" so the load-on-idle $effect
   * in Library.svelte never re-fires) even though the server correctly
   * scopes every request to the new account.
   */
  reset(): void {
    this.items = [];
    this.loadState = "idle";
    this.savedJobIds = new Set();
    this.savingJobIds = new Set();
    this.saveFailedJobIds = new Set();
  }
}

export const libraryStore = new LibraryStore();

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}
