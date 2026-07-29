// SPDX-License-Identifier: AGPL-3.0-or-later
// JobEntry の型とマイグレーション（純粋関数、DOM 非依存）。
// jobs.svelte.ts（$state を使うストア本体）から分離してあるのは、Svelte の
// ルーン変換や DOM（localStorage 等）なしにテストできるようにするため。

export type JobSourceType = "url" | "pdf" | "txt" | "epub";

export interface JobEntry {
  jobId: string;
  sourceType: JobSourceType;
  /** 履歴・現在表示に出す短いラベル。URL ジョブは URL 文字列、PDF/TXT/EPUB ジョブはファイル名。 */
  sourceLabel: string;
  /** URL ジョブでのみ設定される。PDF/TXT/EPUB ジョブには存在しない。 */
  url?: string;
  status: string;
  createdAt?: string;
  title?: string;
  error?: string;
  /**
   * 変換先の機種（"x3" | "x4"）。status === "completed" かつサーバーが実際に
   * 機種を記録しているジョブにのみ存在する（GET /jobs/:jobId 由来）。未完了・
   * 古いジョブでは欠落する。欠落時の表示フォールバック（→ X3）は
   * device-tag.ts の resolveDeviceTag に委ねる。
   */
  device?: string;
}

// 旧形式（sourceType/sourceLabel を持たず url が必須だった頃）のエントリを
// 新形式へ変換する。新形式データはそのまま検証だけして通す。
// 未知の形（どちらの形にも該当しない）は null を返し、読み込み時に捨てる。
export function migrateJobEntry(raw: unknown): JobEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  if (typeof j.jobId !== "string" || typeof j.status !== "string") return null;

  const createdAt = typeof j.createdAt === "string" ? j.createdAt : undefined;
  const title = typeof j.title === "string" ? j.title : undefined;
  const error = typeof j.error === "string" ? j.error : undefined;
  const device = typeof j.device === "string" ? j.device : undefined;

  if (j.sourceType === "url" || j.sourceType === "pdf" || j.sourceType === "txt" || j.sourceType === "epub") {
    if (typeof j.sourceLabel !== "string") return null;
    return {
      jobId: j.jobId,
      sourceType: j.sourceType,
      sourceLabel: j.sourceLabel,
      url: typeof j.url === "string" ? j.url : undefined,
      status: j.status,
      createdAt,
      title,
      error,
      device,
    };
  }

  // 旧形式: sourceType が無く url が必須だった。
  if (typeof j.url === "string") {
    return {
      jobId: j.jobId,
      sourceType: "url",
      sourceLabel: j.url,
      url: j.url,
      status: j.status,
      createdAt,
      title,
      error,
      device,
    };
  }

  return null;
}
