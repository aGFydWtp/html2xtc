// SPDX-License-Identifier: AGPL-3.0-or-later
// ジョブの送信（POST /jobs）と状態ポーリング。
// 挙動は旧 public/index.html のインラインスクリプトをそのまま移植したもの。

import type { Note } from "./i18n.svelte";
import { IN_FLIGHT, jobsStore, type JobEntry } from "./jobs.svelte";

const POLL_MS = 4000;
const MAX_POLL_FAILURES = 5;

interface JobsPostResponse {
  jobId?: string;
  error?: string;
}

interface JobStatusResponse {
  status: string;
  title?: unknown;
  error?: string;
}

// 画面上部（旧 #current）に表示中のジョブと補足メッセージ。
// note は i18n キーのまま保持し、言語切替時に表示側で再解決される。
class CurrentView {
  job = $state<JobEntry | null>(null);
  note = $state<Note | null>(null);

  set(job: JobEntry | null, note: Note | null = null): void {
    this.job = job;
    this.note = note;
  }
}

export const current = new CurrentView();

export const submitting = $state({ busy: false });

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollGen = 0; // 世代トークン: インクリメントで古いポーリングループを打ち切る
let pollFailures = 0; // アクティブなループの連続失敗数
let poll404s = 0; // アクティブなループの連続 404 数
let activeJob: JobEntry | null = null; // 継続ポーリング対象のジョブ

// ジョブを expired へ切り替え、表示されている全箇所（履歴 + 現在表示）へ反映する。
export function markJobExpired(jobId: string): void {
  jobsStore.markExpired(jobId);
  if (current.job && current.job.jobId === jobId) current.job.status = "expired";
}

export function startPolling(job: JobEntry): void {
  clearTimeout(pollTimer);
  pollGen += 1;
  pollFailures = 0;
  poll404s = 0;
  activeJob = job;
  current.set({ ...job });
  void poll(job, pollGen);
}

export async function submitUrl(rawUrl: string, keepLayout: boolean): Promise<void> {
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
      current.set(
        { url, jobId: "", status: "failed", error: body?.error },
        body?.error ? null : { key: "http_error", args: [res.status] },
      );
      return;
    }
    startPolling({ jobId: body.jobId, url, createdAt: new Date().toISOString(), status: "queued" });
    if (activeJob) jobsStore.upsert({ ...activeJob });
  } catch {
    current.set({ url, jobId: "", status: "failed" }, "no_server");
  } finally {
    submitting.busy = false;
  }
}

async function poll(job: JobEntry, gen: number): Promise<void> {
  if (gen !== pollGen) return; // 新しいループに取って代わられた
  try {
    const res = await fetch(`/jobs/${encodeURIComponent(job.jobId)}`);
    if (gen !== pollGen) return;
    if (res.status === 404) {
      // 404 は真の不存在・一時的エラー・ジョブが照会可能になる前の初回ポーリングの
      // いずれもあり得るため、猶予回数を超えたときだけ終端として扱う。
      if (++poll404s >= MAX_POLL_FAILURES) {
        job.status = "expired";
        jobsStore.upsert({ ...job });
        current.set({ ...job });
        return;
      }
    } else if (res.ok) {
      let body: JobStatusResponse;
      try {
        body = await res.json() as JobStatusResponse;
      } catch {
        // JSON でないレスポンス（HTML のエラーページなど）: 回復不能。
        current.set({ ...job }, "poll_fail");
        return;
      }
      pollFailures = 0;
      poll404s = 0;
      job.status = body.status;
      if (typeof body.title === "string" && body.title) job.title = body.title;
      if (body.error) job.error = body.error;
      jobsStore.upsert({ ...job });
      current.set({ ...job });
      if (!IN_FLIGHT.includes(job.status)) return; // completed / failed: 終了
    } else if (++pollFailures >= MAX_POLL_FAILURES) {
      current.set({ ...job }, "poll_fail");
      return;
    }
  } catch {
    if (gen !== pollGen) return;
    if (++pollFailures >= MAX_POLL_FAILURES) {
      current.set({ ...job }, "poll_fail");
      return;
    }
  }
  if (document.hidden) return; // 一時停止; visibilitychange で再開
  pollTimer = setTimeout(() => void poll(job, gen), POLL_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 前回ページを閉じた時点で実行中だったジョブの状態を更新する
// （ジョブごとに単発。最新の 1 件は継続ポーリングを再開する）。
export async function refreshStale(): Promise<void> {
  const stale = jobsStore.list.filter((j) => IN_FLIGHT.includes(j.status)).map((j) => ({ ...j }));
  for (const [i, job] of stale.entries()) {
    if (i === 0) {
      startPolling(job);
      continue;
    }
    for (let attempt = 0; attempt < MAX_POLL_FAILURES; attempt++) {
      if (attempt > 0) await sleep(POLL_MS);
      try {
        const res = await fetch(`/jobs/${encodeURIComponent(job.jobId)}`);
        if (res.status === 404) {
          if (attempt === MAX_POLL_FAILURES - 1) {
            job.status = "expired";
            jobsStore.upsert({ ...job });
          }
          continue;
        }
        if (res.ok) {
          const body = await res.json().catch(() => null) as JobStatusResponse | null;
          if (body) {
            job.status = body.status;
            if (typeof body.title === "string" && body.title) job.title = body.title;
            if (body.error) job.error = body.error;
            jobsStore.upsert({ ...job });
          }
        }
        break;
      } catch {
        break;
      }
    }
  }
}

// タブ非表示中はポーリングを止め、再表示時に新しい世代で再開する。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    clearTimeout(pollTimer);
    return;
  }
  if (activeJob && IN_FLIGHT.includes(activeJob.status)) {
    pollGen += 1;
    pollFailures = 0;
    poll404s = 0;
    void poll(activeJob, pollGen);
  }
});
