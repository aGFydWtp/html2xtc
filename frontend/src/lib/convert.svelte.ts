// SPDX-License-Identifier: AGPL-3.0-or-later
// ジョブの送信（POST /jobs）と状態ポーリング。
// 複数ジョブを jobId ごとに並行してポーリングし、画面上部（旧 #current）へ
// in-flight のジョブと直近の完了 / 失敗エントリ（上限あり）をまとめて表示する。

import type { Note } from "./i18n.svelte";
import { IN_FLIGHT, jobsStore, type JobEntry } from "./jobs.svelte";

const POLL_MS = 4000;
const MAX_POLL_FAILURES = 5;
const MAX_CURRENT = 10; // 現在表示に積むエントリ上限（in-flight は上限超過でも間引かない）

interface JobsPostResponse {
  jobId?: string;
  error?: string;
}

interface JobStatusResponse {
  status: string;
  title?: unknown;
  error?: string;
}

// 画面上部（旧 #current）に表示する 1 件分のエントリ。
// note は i18n キーのまま保持し、言語切替時に表示側で再解決される。
// key はジョブなら jobId、送信自体の失敗（ジョブ非依存エラー）なら "err:N"。
export interface CurrentEntry {
  key: string;
  job: JobEntry;
  note: Note | null;
}

// 画面上部に表示中のエントリ群。新しいものを先頭に積む（履歴と同じ並び）。
// 完了 / 失敗エントリは MAX_CURRENT 件を上限に直近ぶんを残し、超過時は古いものから
// 間引く（追跡中の in-flight ジョブは間引き対象外。ライブ表示が壊れるため）。
class CurrentView {
  entries = $state<CurrentEntry[]>([]);

  upsert(key: string, job: JobEntry, note: Note | null): void {
    const i = this.entries.findIndex((e) => e.key === key);
    if (i === -1) {
      this.entries.unshift({ key, job, note });
      this.prune();
    } else {
      this.entries[i] = { key, job, note };
    }
  }

  // 上限超過ぶんを末尾（古い順）から間引く。ただし in-flight ジョブは残す。
  private prune(): void {
    let over = this.entries.length - MAX_CURRENT;
    for (let i = this.entries.length - 1; i >= 0 && over > 0; i--) {
      if (IN_FLIGHT.includes(this.entries[i].job.status)) continue;
      this.entries.splice(i, 1);
      over--;
    }
  }

  markExpired(jobId: string): void {
    const e = this.entries.find((x) => x.key === jobId);
    if (e) e.job = { ...e.job, status: "expired" };
  }
}

export const current = new CurrentView();

export const submitting = $state({ busy: false });

// jobId ごとの並行ポーリング状態。map の値と `p` の同一性が世代トークンを兼ねる:
// startPolling / 再開でエントリを差し替えると、進行中の古い poll(p) は isStale で
// 自ら打ち切られる。終端（completed / failed / expired 等）で map から削除する。
interface Poller {
  job: JobEntry;
  failures: number; // 連続失敗数
  poll404s: number; // 連続 404 数
  timer?: ReturnType<typeof setTimeout>;
}

const pollers = new Map<string, Poller>();

let errSeq = 0; // ジョブ非依存エラー用の一意キー採番

// この poll ループが既に別のループ（差し替え / 削除）に取って代わられているか。
function isStale(p: Poller): boolean {
  return pollers.get(p.job.jobId) !== p;
}

// jobId のポーリングを（差し替えで）開始し、新しい Poller を返す。
// 既存のタイマーは止め、進行中の古い poll は isStale で失効させる。
function beginPoll(job: JobEntry): Poller {
  const prev = pollers.get(job.jobId);
  if (prev?.timer) clearTimeout(prev.timer);
  const p: Poller = { job, failures: 0, poll404s: 0 };
  pollers.set(job.jobId, p);
  return p;
}

// ジョブを expired へ切り替え、表示されている全箇所（履歴 + 現在表示）へ反映する。
export function markJobExpired(jobId: string): void {
  jobsStore.markExpired(jobId);
  current.markExpired(jobId);
}

// ジョブ非依存エラー（送信失敗など）を現在表示へ積む。ジョブごとに一意キーで
// 追加するため、連続投入時も各失敗が個別に残る。
function submissionError(job: JobEntry, note: Note | null): void {
  current.upsert(`err:${++errSeq}`, job, note);
}

export function startPolling(job: JobEntry): void {
  const p = beginPoll({ ...job });
  current.upsert(job.jobId, { ...p.job }, null);
  void poll(p);
}

// displayTitle は青空文庫など、投入元が作品名を持つ場合の初期表示タイトル。
// 指定時は poll でサーバー由来タイトルに上書きされない（下の !job.title ガード）。
export async function submitUrl(rawUrl: string, keepLayout: boolean, displayTitle?: string): Promise<void> {
  const url = rawUrl.trim();
  if (!url) return;
  submitting.busy = true;
  try {
    const res = await fetch("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // mode は常に明示送信する: UI の既定（未チェック）は extract だが、
      // API 自体の mode 省略時既定は "full" のまま。
      body: JSON.stringify({ url, mode: keepLayout ? "full" : "extract" }),
    });
    const body = await res.json().catch(() => null) as JobsPostResponse | null;
    if (!res.ok || !body || typeof body.jobId !== "string") {
      // サーバー由来のエラー文字列はそのまま job に保持し、汎用フォールバックは
      // 言語切替に耐えるよう i18n キーの note として渡す。
      submissionError(
        { url, jobId: "", status: "failed", error: body?.error },
        body?.error ? null : { key: "http_error", args: [res.status] },
      );
      return;
    }
    // 投入直後に履歴へ queued を記録してから並行ポーリングを開始する。
    const job: JobEntry = {
      jobId: body.jobId,
      url,
      createdAt: new Date().toISOString(),
      status: "queued",
      ...(displayTitle ? { title: displayTitle } : {}),
    };
    jobsStore.upsert({ ...job });
    startPolling(job);
  } catch {
    submissionError({ url, jobId: "", status: "failed" }, "no_server");
  } finally {
    submitting.busy = false;
  }
}

async function poll(p: Poller): Promise<void> {
  const job = p.job;
  if (isStale(p)) return; // 新しいループに取って代わられた
  try {
    const res = await fetch(`/jobs/${encodeURIComponent(job.jobId)}`);
    if (isStale(p)) return;
    if (res.status === 404) {
      // 404 は真の不存在・一時的エラー・ジョブが照会可能になる前の初回ポーリングの
      // いずれもあり得るため、猶予回数を超えたときだけ終端として扱う。
      if (++p.poll404s >= MAX_POLL_FAILURES) {
        job.status = "expired";
        jobsStore.upsert({ ...job });
        current.upsert(job.jobId, { ...job }, null);
        pollers.delete(job.jobId);
        return;
      }
    } else if (res.ok) {
      let body: JobStatusResponse;
      try {
        body = await res.json() as JobStatusResponse;
      } catch {
        // JSON でないレスポンス（HTML のエラーページなど）: 回復不能。
        current.upsert(job.jobId, { ...job }, "poll_fail");
        pollers.delete(job.jobId);
        return;
      }
      p.failures = 0;
      p.poll404s = 0;
      job.status = body.status;
      // 投入元が付けた表示タイトル（青空文庫の作品名など）は保持し、無い場合のみ
      // サーバー由来タイトルを採用する。
      if (typeof body.title === "string" && body.title && !job.title) job.title = body.title;
      if (body.error) job.error = body.error;
      jobsStore.upsert({ ...job });
      current.upsert(job.jobId, { ...job }, null);
      if (!IN_FLIGHT.includes(job.status)) { // completed / failed: 終了
        pollers.delete(job.jobId);
        return;
      }
    } else if (++p.failures >= MAX_POLL_FAILURES) {
      current.upsert(job.jobId, { ...job }, "poll_fail");
      pollers.delete(job.jobId);
      return;
    }
  } catch {
    if (isStale(p)) return;
    if (++p.failures >= MAX_POLL_FAILURES) {
      current.upsert(job.jobId, { ...job }, "poll_fail");
      pollers.delete(job.jobId);
      return;
    }
  }
  if (document.hidden) return; // 一時停止; visibilitychange で再開
  p.timer = setTimeout(() => void poll(p), POLL_MS);
}

// 前回ページを閉じた時点で実行中だったジョブを、全件並行でポーリング再開する。
export async function refreshStale(): Promise<void> {
  const stale = jobsStore.list.filter((j) => IN_FLIGHT.includes(j.status)).map((j) => ({ ...j }));
  for (const job of stale) startPolling(job);
}

// タブ非表示中は全ジョブのポーリングを止め、再表示時に in-flight を全件再開する。
// 再開は beginPoll でエントリを差し替えるため、非表示中に解決した古い poll は
// isStale で失効し、二重ループにならない。
// module スコープでの登録: このモジュールは SPA で 1 ページにつき 1 回しか
// import されないシングルトン前提のため、teardown（removeEventListener）は不要。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    for (const p of pollers.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = undefined;
    }
    return;
  }
  for (const existing of [...pollers.values()]) {
    if (!IN_FLIGHT.includes(existing.job.status)) continue;
    void poll(beginPoll(existing.job));
  }
});
