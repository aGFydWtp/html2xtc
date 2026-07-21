// SPDX-License-Identifier: AGPL-3.0-or-later
// localStorage に保存する変換履歴（最大 50 件）。

import { type JobEntry, type JobSourceType, migrateJobEntry } from "./job-entry";

export type { JobEntry, JobSourceType };
export { migrateJobEntry };

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
    return raw.map(migrateJobEntry).filter((j): j is JobEntry => j !== null);
  } catch {
    return [];
  }
}

// マルチタブ整合性: 各ミューテーションの冒頭で localStorage から再読込し、
// 最新のスナップショットに対して変更・保存する（旧 public/index.html と同じ
// 整合モデル）。メモリ上の古いリストを書き戻すと、別タブでの履歴クリアや追加を
// このタブのポーリング由来の upsert が上書きしてしまうため。
class JobsStore {
  list = $state<JobEntry[]>(loadFromStorage());

  // 変更後のリストをメモリ（$state）と localStorage の両方へ反映する。
  private commit(list: JobEntry[]): void {
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
    this.list = list;
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  }

  upsert(entry: JobEntry): void {
    const list = loadFromStorage();
    const i = list.findIndex((j) => j.jobId === entry.jobId);
    if (i === -1) list.unshift(entry);
    else list[i] = { ...list[i], ...entry };
    this.commit(list);
  }

  markExpired(jobId: string): void {
    const list = loadFromStorage();
    const j = list.find((x) => x.jobId === jobId);
    if (j) {
      j.status = "expired";
      this.commit(list);
    } else {
      // 対象が見つからなくても（別タブでクリア済み等）、再読込結果は表示へ反映する。
      this.list = list;
    }
  }

  clear(): void {
    localStorage.removeItem(STORE_KEY);
    this.list = [];
  }
}

export const jobsStore = new JobsStore();

// 別タブによる書き込みをリアルタイムに表示へ反映する。storage イベントは
// 「他のタブ」でのみ発火するため、自タブの commit とループにはならない。
// key === null は localStorage.clear() を示す。
window.addEventListener("storage", (e) => {
  if (e.key === null || e.key === STORE_KEY) jobsStore.list = loadFromStorage();
});

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
