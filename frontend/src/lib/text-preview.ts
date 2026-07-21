// SPDX-License-Identifier: AGPL-3.0-or-later
// 本文プレビュー・X3ページプレビューの構築（実装仕様書 §9.1, §9.3-9.7, §10.6, §10.7）。

import { escapeHtml, textToParagraphHtml } from "./text-normalize";
import type { TextConvertOptions } from "./text-options";

// §10.6: 初期表示は先頭50,000文字まで。
export const BODY_PREVIEW_INITIAL_CHARS = 50000;

export interface BodyPreviewResult {
  visibleText: string;
  hasMore: boolean;
  totalChars: number;
}

// visibleChars を渡すことで「続きを表示」クリック後の追加表示にも同じ関数を使える。
export function buildBodyPreview(
  normalizedText: string,
  visibleChars: number = BODY_PREVIEW_INITIAL_CHARS,
): BodyPreviewResult {
  const chars = [...normalizedText];
  const total = chars.length;
  const clamped = Math.max(0, Math.min(visibleChars, total));
  return {
    visibleText: chars.slice(0, clamped).join(""),
    hasMore: clamped < total,
    totalChars: total,
  };
}

// §9.3 共通CSS変数
export function buildCssVariables(options: TextConvertOptions): string {
  return `:root {
  --page-width: 528px;
  --page-height: 792px;
  --font-family: "${options.font}", sans-serif;
  --font-size: ${options.fontSizePx}px;
  --line-height: ${options.lineHeight};
  --paragraph-spacing: ${options.paragraphSpacingEm}em;
  --margin-top: ${options.margins.top}px;
  --margin-right: ${options.margins.right}px;
  --margin-bottom: ${options.margins.bottom}px;
  --margin-left: ${options.margins.left}px;
}`;
}

// §9.4/§9.5/§9.6 組版CSS（横書き・縦書き・両端揃え・空白保持）。
// ブラウザ内DOMプレビュー用のため @page は含めない（ページ枠は .x3-page 要素の
// 固定サイズで表現する）。
export function buildTypesetCss(options: TextConvertOptions): string {
  const directionCss =
    options.layout === "vertical"
      ? `.content {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  overflow-wrap: anywhere;
  height: 100%;
}
.content p {
  margin-block-end: var(--paragraph-spacing);
}`
      : `.content {
  writing-mode: horizontal-tb;
  text-orientation: mixed;
  overflow-wrap: anywhere;
}
.content p {
  margin: 0 0 var(--paragraph-spacing);
  orphans: 2;
  widows: 2;
}`;

  const alignCss =
    options.textAlign === "justify"
      ? `.content {
  text-align: justify;
  text-justify: inter-character;
}`
      : "";

  const whiteSpaceCss = options.preserveSpaces
    ? `.content {
  white-space: pre-wrap;
  tab-size: 4;
}`
    : "";

  return [directionCss, alignCss, whiteSpaceCss].filter(Boolean).join("\n");
}

// §9.1: 表題と著者が両方空の場合は book-header を出力しない。
export function buildHeaderHtml(title: string, author: string): string {
  const t = title.trim();
  const a = author.trim();
  if (!t && !a) return "";
  const titleHtml = t ? `<h1>${escapeHtml(t)}</h1>` : "";
  const authorHtml = a ? `<p class="author">${escapeHtml(a)}</p>` : "";
  return `<header class="book-header">${titleHtml}${authorHtml}</header>`;
}

// §10.7 X3プレビュー: 先頭ページ相当だけを表示する。厳密な改ページ計算は行わず
// （実際の改ページは Browser Run 側で決まる）、DOM描画コストを抑えるために本文
// プレビューよりさらに短い文字数で本文を打ち切る。
export const X3_PREVIEW_MAX_CHARS = 4000;

export function buildX3PreviewBodyHtml(normalizedText: string): string {
  const chars = [...normalizedText];
  const clipped = chars.length > X3_PREVIEW_MAX_CHARS ? chars.slice(0, X3_PREVIEW_MAX_CHARS).join("") : normalizedText;
  return textToParagraphHtml(clipped);
}
