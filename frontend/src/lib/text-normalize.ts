// SPDX-License-Identifier: AGPL-3.0-or-later
// テキスト正規化・段落HTML化（実装仕様書 §4.1, §8, §9.2）。

// §4.1: 入力本文は常にプレーンテキストとして扱い、HTML生成時は必ずエスケープする。
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// §8.1 改行コード統一: CRLF → LF, CR → LF
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// §8.3 制御文字: 許可は LF・TAB のみ。除去対象は
// U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+007F。
// 除去した文字自体はログへ出さず、件数だけを呼び出し元へ返す。
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function stripControlChars(text: string): { text: string; removedCount: number } {
  let removedCount = 0;
  const stripped = text.replace(CONTROL_CHAR_RE, () => {
    removedCount++;
    return "";
  });
  return { text: stripped, removedCount };
}

// §8.5 preserveSpaces=false: 行末の半角スペース・タブを削除する。
function trimTrailingLineWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

// §8.4 空行: 空白だけの行も空行として扱い、連続空行を maxConsecutiveBlankLines
// 以下に制限する。
function limitConsecutiveBlankLines(text: string, maxConsecutiveBlankLines: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    if (isBlank) {
      blankRun++;
      if (blankRun > maxConsecutiveBlankLines) continue;
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  return out.join("\n");
}

export interface NormalizeTextOptions {
  maxConsecutiveBlankLines: number;
  preserveSpaces: boolean;
}

export interface NormalizeTextResult {
  text: string;
  controlCharsRemoved: number;
}

// 改行統一 → NFC正規化（§8.2。NFKCは使用しない）→ 制御文字除去 →
// (preserveSpaces=false のときのみ)行末空白除去 → 連続空行の制限、の順で適用する。
export function normalizeText(rawText: string, options: NormalizeTextOptions): NormalizeTextResult {
  let text = normalizeLineEndings(rawText);
  text = text.normalize("NFC");
  const stripped = stripControlChars(text);
  text = stripped.text;
  if (!options.preserveSpaces) {
    text = trimTrailingLineWhitespace(text);
  }
  text = limitConsecutiveBlankLines(text, options.maxConsecutiveBlankLines);
  return { text, controlCharsRemoved: stripped.removedCount };
}

// §9.2 本文変換: 空行（2つ以上の連続LF）で区切られたブロックを1段落とし、
// 段落内の単一改行は保持して <br> にする（行の自動連結はMVP対象外）。
export function textToParagraphHtml(normalizedText: string): string {
  return normalizedText
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}

export function countCharacters(text: string): number {
  return [...text].length;
}

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}
