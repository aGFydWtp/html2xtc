// SPDX-License-Identifier: AGPL-3.0-or-later
// localStorage に保存する変換履歴（最大 50 件）。

export interface JobEntry {
  jobId: string;
  url: string;
  status: string;
  createdAt?: string;
  title?: string;
  error?: string;
}

const STORE_KEY = "xtc-jobs";
const MAX_ENTRIES = 50;

export const IN_FLIGHT = ["queued", "rendering", "converting"];

// サーバー側の保持期限を過ぎた completed エントリは、404 になるダウンロードを
// 提示する代わりに expired として表示する。
export const EXPIRY_MS = 24 * 60 * 60 * 1000;

function loadFromStorage(): JobEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (j): j is JobEntry =>
        !!j && typeof j === "object"
        && typeof (j as JobEntry).jobId === "string"
        && typeof (j as JobEntry).url === "string"
        && typeof (j as JobEntry).status === "string",
    );
  } catch {
    return [];
  }
}

class JobsStore {
  list = $state<JobEntry[]>(loadFromStorage());

  private save(): void {
    if (this.list.length > MAX_ENTRIES) this.list.length = MAX_ENTRIES;
    localStorage.setItem(STORE_KEY, JSON.stringify(this.list));
  }

  upsert(entry: JobEntry): void {
    const i = this.list.findIndex((j) => j.jobId === entry.jobId);
    if (i === -1) this.list.unshift(entry);
    else this.list[i] = { ...this.list[i], ...entry };
    this.save();
  }

  markExpired(jobId: string): void {
    const j = this.list.find((x) => x.jobId === jobId);
    if (j) {
      j.status = "expired";
      this.save();
    }
  }

  clear(): void {
    localStorage.removeItem(STORE_KEY);
    this.list = [];
  }
}

export const jobsStore = new JobsStore();

export function effectiveStatus(j: JobEntry): string {
  if (j.status === "completed") {
    const time = Date.parse(j.createdAt ?? "");
    if (!Number.isNaN(time) && Date.now() - time > EXPIRY_MS) return "expired";
  }
  return j.status;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
