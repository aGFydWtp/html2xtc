// SPDX-License-Identifier: AGPL-3.0-or-later
// 汎用OPDS取り込みの型とロジック（純粋関数、DOM/Svelteランタイム非依存）。
// opds.svelte.ts（$state を使うストア本体）から分離してあるのは、job-entry.ts /
// jobs.svelte.ts と同じ理由（Svelteのルーン変換なしに vitest でテストできるように
// するため）。内部の型・関数名はいずれも汎用OPDS用で、Memlane専用にしない
// （仕様書 §28）。

// --- サーバーAPIが返す型（仕様書 §9.1。secret URL・username・password・元hrefは含まない） ---

export interface OpdsConnectionSummary {
  id: string;
  name: string;
  provider: string;
  authType: string;
  host: string;
  lastVerifiedAt: string | null;
}

export interface OpdsNavigationEntry {
  kind: "navigation";
  id: string;
  title: string;
  cursor: string;
}

export interface OpdsPublicationEntry {
  kind: "publication";
  id: string;
  title: string;
  author: string | null;
  updatedAt: string | null;
  canImportEpub: boolean;
  acquisitionCursor: string | null;
}

export type OpdsEntry = OpdsNavigationEntry | OpdsPublicationEntry;

export interface OpdsCatalogPage {
  title: string;
  entries: OpdsEntry[];
  nextCursor: string | null;
  previousCursor: string | null;
  searchSupported: boolean;
  searchCursor: string | null;
}

// カタログ1画面あたりの選択可能上限（仕様書 §8.4）。
export const OPDS_SELECTION_MAX = 5;

// --- パース（サーバー応答の実行時検証） -------------------------------------------

export function parseConnectionSummary(raw: unknown): OpdsConnectionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string"
    || typeof r.name !== "string"
    || typeof r.provider !== "string"
    || typeof r.authType !== "string"
    || typeof r.host !== "string"
  ) return null;
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    authType: r.authType,
    host: r.host,
    lastVerifiedAt: typeof r.lastVerifiedAt === "string" ? r.lastVerifiedAt : null,
  };
}

export function parseConnectionSummaries(raw: unknown): OpdsConnectionSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: OpdsConnectionSummary[] = [];
  for (const x of raw) {
    const c = parseConnectionSummary(x);
    if (c) out.push(c);
  }
  return out;
}

export function findConnectionByProvider(
  connections: OpdsConnectionSummary[],
  provider: string,
): OpdsConnectionSummary | null {
  return connections.find((c) => c.provider === provider) ?? null;
}

export function parseOpdsEntry(raw: unknown): OpdsEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.title !== "string") return null;

  if (r.kind === "navigation") {
    if (typeof r.cursor !== "string") return null;
    return { kind: "navigation", id: r.id, title: r.title, cursor: r.cursor };
  }
  if (r.kind === "publication") {
    if (typeof r.canImportEpub !== "boolean") return null;
    return {
      kind: "publication",
      id: r.id,
      title: r.title,
      author: typeof r.author === "string" ? r.author : null,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
      canImportEpub: r.canImportEpub,
      acquisitionCursor: typeof r.acquisitionCursor === "string" ? r.acquisitionCursor : null,
    };
  }
  return null;
}

export function parseOpdsEntries(raw: unknown): OpdsEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: OpdsEntry[] = [];
  for (const x of raw) {
    const e = parseOpdsEntry(x);
    if (e) out.push(e);
  }
  return out;
}

// entry id は Svelte の {#each ... (entry.id)} のキーに使われるため、同一 id が
// 複数件届くと描画が壊れる（duplicate key エラー）。Worker側でも重複除去を
// 入れる予定だが、フロント単独でも壊れないよう parseCatalogPage の境界で
// 先勝ちの重複除去を行う。
export function dedupeOpdsEntries(entries: OpdsEntry[]): OpdsEntry[] {
  const seen = new Set<string>();
  const out: OpdsEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

export function parseCatalogPage(raw: unknown): OpdsCatalogPage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== "string" || typeof r.searchSupported !== "boolean") return null;
  return {
    title: r.title,
    entries: dedupeOpdsEntries(parseOpdsEntries(r.entries)),
    nextCursor: typeof r.nextCursor === "string" ? r.nextCursor : null,
    previousCursor: typeof r.previousCursor === "string" ? r.previousCursor : null,
    searchSupported: r.searchSupported,
    searchCursor: typeof r.searchCursor === "string" ? r.searchCursor : null,
  };
}

// --- entry の選択可否 --------------------------------------------------------------

// navigation entryは選択不可。EPUB acquisitionを持つpublicationだけ選択可能
// （仕様書 §8.4）。
export function isImportableEntry(entry: OpdsEntry): entry is OpdsPublicationEntry {
  return entry.kind === "publication" && entry.canImportEpub && entry.acquisitionCursor !== null;
}

// --- 選択状態（aozora.svelte.ts の toggle と同じ Map ベースの流儀） -----------------

export function toggleOpdsSelection(
  selected: Map<string, OpdsPublicationEntry>,
  entry: OpdsPublicationEntry,
  checked: boolean,
  max: number = OPDS_SELECTION_MAX,
): Map<string, OpdsPublicationEntry> {
  const next = new Map(selected);
  if (checked) {
    if (next.has(entry.id) || next.size >= max) return selected;
    next.set(entry.id, entry);
  } else {
    next.delete(entry.id);
  }
  return next;
}

// --- 取り込み結果の集計（仕様書 §8.5） ----------------------------------------------

export interface OpdsImportOutcome {
  id: string;
  ok: boolean;
}

export interface OpdsImportSummary {
  startedCount: number;
  failedCount: number;
}

export function summarizeOpdsImportOutcomes(outcomes: OpdsImportOutcome[]): OpdsImportSummary {
  let startedCount = 0;
  let failedCount = 0;
  for (const o of outcomes) {
    if (o.ok) startedCount++;
    else failedCount++;
  }
  return { startedCount, failedCount };
}

// --- 限定同時実行数での並行実行（仕様書 §8.5「推奨同時実行数: 2」） -----------------
// worker は自身で失敗を捕捉し、結果として返すこと（reject させない）。1件が
// reject すると、そのワーカーの以後のアイテムの実行が止まってしまうため
// （Promise.all 自体は他ワーカーには影響しないが、当該ワーカーのループが
// 打ち切られる）。

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function runOne(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
  return results;
}

// --- APIエラーcode → i18nキーの対応（仕様書 §23）。未対応のcodeはnullを返し、
// 呼び出し側でサーバーメッセージ等へフォールバックする。

export type OpdsErrorMessageKey =
  | "memlane_invalid_url"
  | "memlane_https_required"
  | "memlane_feed_invalid"
  | "memlane_upstream_error"
  | "memlane_timeout"
  | "memlane_cursor_invalid"
  | "memlane_epub_unavailable"
  | "memlane_session_expired"
  | "memlane_import_disabled";

const OPDS_ERROR_CODE_MESSAGE_KEYS: Record<string, OpdsErrorMessageKey> = {
  OPDS_CONNECTION_NOT_FOUND: "memlane_session_expired",
  OPDS_CONNECTION_INVALID: "memlane_invalid_url",
  OPDS_CURSOR_INVALID: "memlane_cursor_invalid",
  OPDS_FEED_INVALID: "memlane_feed_invalid",
  OPDS_UPSTREAM_ERROR: "memlane_upstream_error",
  OPDS_EPUB_UNAVAILABLE: "memlane_epub_unavailable",
  OPDS_IMPORT_DISABLED: "memlane_import_disabled",
};

export function mapOpdsErrorCode(code: string | null): OpdsErrorMessageKey | null {
  if (!code) return null;
  return OPDS_ERROR_CODE_MESSAGE_KEYS[code] ?? null;
}
