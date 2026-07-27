// SPDX-License-Identifier: AGPL-3.0-or-later
// フロントエンド本文プレビュー用のMarkdown変換（Markdown対応仕様書 §17.5）。
//
// バックエンド（src/text-prepare.ts）と同じ形で共有パッケージ @html2xtc/markdown-text
// へ markdown-it インスタンスを注入する — パーサー設定・token走査・安全なHTML
// レンダリング・章抽出は共有パッケージ側にあり、ここでは複製しない
// （Markdown対応仕様書 §6.3「backendとfrontendのMarkdown変換ロジックを複製しない
// こと」）。MarkdownIt インスタンスはモジュールスコープで一度だけ生成し、以後の
// プレビュー呼び出しで使い回す（src/text-prepare.ts の markdownConverter と同じ
// 方針）。

import MarkdownIt from "markdown-it";
import { createMarkdownConverter, MARKDOWN_IT_OPTIONS, type ParsedMarkdownDocument } from "@html2xtc/markdown-text";

const markdownConverter = createMarkdownConverter(() => new MarkdownIt(MARKDOWN_IT_OPTIONS));

/**
 * 本文プレビュー用のfail-softなMarkdownパース（仕様書 §17.5「パース例外
 * （MarkdownComplexityLimitError 含む）はプレビューを壊さないよう握って空表示に
 * フォールバックすること」）。`source` は既にX3プレビューと同じ安全な切り出し
 * （selectTextPreview経由）を通した文字列を渡す想定 — aozoraPreviewDoc
 * （TextInputPanel.svelte）と同じ理由で、全文（最大5MiB）を毎回パースしない。
 */
export function parseMarkdownPreview(source: string): ParsedMarkdownDocument | null {
  try {
    return markdownConverter.parse(source);
  } catch {
    return null;
  }
}
