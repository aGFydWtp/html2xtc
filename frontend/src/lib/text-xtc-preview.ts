// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /preview/text 経由の同期XTC実機プレビュー取得（実装仕様書 §14/§18/§20）。
//
// TextPreviewErrorMessageKey は「サーバーのエラー code → i18n キー」の対応表。
// server-error-text.ts と同じ理由（i18n.svelte.ts は $state を使う rune ファイル
// で、svelte プリプロセッサなしの素の vitest からは import できない）で、
// `import type` のみ（型情報は消去されるため実行時 import は発生しない）に
// とどめ、この対応表自体は純粋関数として単体テスト可能にしてある。

import { selectTextPreview } from "./text-preview";
import type { TextConvertOptions } from "./text-options";
import type { Messages } from "./i18n.svelte";

/** src/preview/text-preview.ts の TextPreviewErrorCode と対応（バックエンドと
 * フロントエンドは別ビルドのため型を共有できず、意図的に複製している）。
 * "UNKNOWN" はレスポンス本文が JSON でない、または code フィールドを含まない
 * 場合のフロント側フォールバック。 */
export type TextPreviewErrorCode =
  | "INVALID_REQUEST"
  | "TEXT_TOO_LONG"
  | "EMPTY_TEXT"
  | "INVALID_OPTIONS"
  | "FONT_FETCH_FAILED"
  | "PDF_GENERATION_FAILED"
  | "PDF_TOO_LARGE"
  | "CONTAINER_UNAVAILABLE"
  | "XTC_CONVERSION_FAILED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "UNKNOWN";

export class TextPreviewRequestError extends Error {
  readonly status: number;
  readonly code: TextPreviewErrorCode;

  constructor(status: number, code: TextPreviewErrorCode, message: string) {
    super(message);
    this.name = "TextPreviewRequestError";
    this.status = status;
    this.code = code;
  }
}

export type TextPreviewErrorMessageKey = keyof Pick<
  Messages,
  | "text_x3_preview_rate_limited"
  | "text_x3_preview_timeout"
  | "text_x3_preview_too_long"
  | "text_x3_preview_empty"
  | "text_x3_preview_failed"
>;

/** サーバーの機械可読な code から表示メッセージキーを決定する。未知の code
 * （将来サーバー側に追加された code や UNKNOWN）は汎用の失敗メッセージへ。 */
export function resolveTextPreviewErrorMessageKey(code: TextPreviewErrorCode): TextPreviewErrorMessageKey {
  switch (code) {
    case "RATE_LIMITED":
      return "text_x3_preview_rate_limited";
    case "TIMEOUT":
      return "text_x3_preview_timeout";
    case "TEXT_TOO_LONG":
      return "text_x3_preview_too_long";
    case "EMPTY_TEXT":
      return "text_x3_preview_empty";
    default:
      return "text_x3_preview_failed";
  }
}

// --- X3プレビュー結果のメモリキャッシュ（同じ入力での再生成クリックをAPI再取得
// せず即時表示するため）。実装は pdf-preview.ts の LimitedPageCache と同じLRUだが、
// キーがページ番号(number)ではなく「送信テキスト+options」の文字列なので汎用化した。
export const TEXT_X3_PREVIEW_CACHE_LIMIT = 8;

// 汎用クラスなので text 固有の既定値は持たせず、呼び出し側に上限を明示させる。
export class LimitedCache<K, V> {
  private map = new Map<K, V>();
  constructor(private limit: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key); // LRU: 既存キーは末尾へ移動
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/**
 * X3プレビューのキャッシュキーを生成する。実際にサーバーへ送信されるテキスト
 * （selectTextPreviewで切り詰め後）と options のJSON表現を連結する — 見た目に
 * 影響するフィールドは options の全フィールドなので、options全体をそのまま使う。
 * options はフィールドの追加・削除がない限り常に同じキー順でシリアライズされる
 * （applyTextPreset/setTextLayoutは既存options を spread するのみで新規キーを
 * 追加しないため）。
 */
export function buildTextXtcPreviewCacheKey(fullText: string, options: TextConvertOptions): string {
  // セパレータにNUL文字(\u0000)を使い、本文とoptionsのJSON文字列が偶然結合して
  // 衝突することを避ける（NULは通常テキスト本文に現れない）。
  return `${selectTextPreview(fullText)}\u0000${JSON.stringify(options)}`;
}

async function parsePreviewError(response: Response): Promise<TextPreviewRequestError> {
  let code: TextPreviewErrorCode = "UNKNOWN";
  let message = `preview request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.code === "string") {
      code = body.code as TextPreviewErrorCode;
    }
    if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    // レスポンス本文が JSON でない場合は既定のメッセージのまま。
  }
  return new TextPreviewRequestError(response.status, code, message);
}

/**
 * 本文先頭部分（selectTextPreview）を POST /preview/text へ送信し、成功時は
 * XTC バイト列を返す。非 2xx は TextPreviewRequestError を throw する。
 * signal は世代管理（実装仕様書 §18）用: 設定変更で前のリクエストを中止できる
 * よう AbortController.signal を渡せる。
 */
export async function requestTextXtcPreview(
  fullText: string,
  options: TextConvertOptions,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const text = selectTextPreview(fullText);
  const response = await fetch("/preview/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, options }),
    signal,
  });
  if (!response.ok) {
    throw await parsePreviewError(response);
  }
  return response.arrayBuffer();
}
