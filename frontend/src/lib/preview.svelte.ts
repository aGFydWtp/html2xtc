// SPDX-License-Identifier: AGPL-3.0-or-later
// XTC プレビューの状態管理。fetch した XTC は jobId キーでキャッシュ（上限 5 件）し、
// パース不能なファイルはセッション中は恒久的にプレビュー無効とする
// （ダウンロードリンクは維持: 将来 xtctool の出力形式が変わった場合のフォールバック）。

import { SvelteSet } from "svelte/reactivity";
import type { Note } from "./i18n.svelte";
import { markJobExpired } from "./convert.svelte";
import { parseXtc, type ParsedXtc } from "./xtc";

const PREVIEW_CACHE_MAX = 5;

export const previewCache = new Map<string, ParsedXtc>(); // 表示するページだけをデコードする
export const previewBroken = new SvelteSet<string>(); // パースに失敗した jobId（セッション中は恒久）

export type PreviewState =
  | { jobId: string; loading: true }
  | { jobId: string; page: number }
  | { jobId: string; note: Note };

class PreviewStore {
  state = $state<PreviewState | null>(null);
}

export const preview = new PreviewStore();

export function previewFail(jobId: string, note: Note): void {
  if (!preview.state || preview.state.jobId !== jobId) return;
  if (note === "preview_parse_fail") previewBroken.add(jobId);
  preview.state = { jobId, note };
}

export async function openPreview(jobId: string): Promise<void> {
  if (previewBroken.has(jobId)) return;
  const s = preview.state;
  if (s && s.jobId === jobId && "loading" in s) return; // fetch 実行中
  if (!previewCache.has(jobId)) {
    preview.state = { jobId, loading: true };
    let res: Response;
    try {
      res = await fetch(`/jobs/${encodeURIComponent(jobId)}/download`);
    } catch {
      return previewFail(jobId, "no_server");
    }
    if (!preview.state || preview.state.jobId !== jobId) return; // その間にダイアログが閉じられた
    if (res.status === 404) {
      markJobExpired(jobId);
      return previewFail(jobId, "preview_expired");
    }
    if (!res.ok) {
      return previewFail(jobId, { key: "http_error", args: [res.status] });
    }
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch {
      return previewFail(jobId, "no_server");
    }
    if (!preview.state || preview.state.jobId !== jobId) return;
    try {
      // 上限超過時は挿入順で最古のエントリを evict（FIFO。LRU ではない。旧実装踏襲）。
      if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value!);
      previewCache.set(jobId, parseXtc(buf));
    } catch {
      return previewFail(jobId, "preview_parse_fail");
    }
  }
  preview.state = { jobId, page: 0 };
}

/**
 * 同期プレビュー（POST /preview/text）で受け取った ArrayBuffer を、既存の
 * ジョブID前提の openPreview と同じ状態機械（previewCache / preview.state）
 * へそのまま乗せる。fetch を一切行わない点だけが openPreview と異なる — jobId
 * の代わりに呼び出し側が渡す（衝突しない限り何でもよい）固定キーを使う。
 * ダウンロード履歴・ジョブとは無関係なため previewBroken/markJobExpired は
 * 触らない（実装仕様書 §18: プレビューを履歴へ保存しない）。
 */
export function openPreviewFromBytes(bytes: ArrayBuffer, key = "__preview__"): void {
  try {
    // 上限超過時は挿入順で最古のエントリを evict（openPreview と同じ FIFO）。
    if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value!);
    previewCache.set(key, parseXtc(bytes));
  } catch {
    preview.state = { jobId: key, note: "preview_parse_fail" };
    return;
  }
  preview.state = { jobId: key, page: 0 };
}

export function movePreview(delta: number): void {
  const s = preview.state;
  if (!s || !("page" in s) || !previewCache.has(s.jobId)) return;
  const next = s.page + delta;
  if (next < 0 || next >= previewCache.get(s.jobId)!.pages.length) return;
  preview.state = { jobId: s.jobId, page: next };
}

export function closePreview(): void {
  preview.state = null;
}
