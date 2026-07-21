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

// --- ハードラップ行の自動連結 -----------------------------------------------
//
// 日本語書籍TXTの多くは固定幅（約40-50字）でハードラップされているため、この
// ヒューリスティックは段落内の隣接行を自然な文章として連結する。バックエンド
// （src/text-normalize.ts の joinWrappedLines）と完全に同一のロジックを保つ
// こと — frontend は src/ を import できないため意図的に複製している。

// A が文末・引用末で終わる場合は改行を保持する（ハードラップの途中ではなく、
// 文や引用の区切りとみなす）。
const SENTENCE_END_CHARS = new Set([
  "。", "！", "？", "…", "‥", "」", "』", "）", "】", "〕", "〉", "》", ".", "!", "?",
]);

// B が段落頭マーカーで始まる場合は改行を保持する（ハードラップの続きではなく、
// インデントや開き引用符を伴う新しい段落的な単位とみなす）。
const PARAGRAPH_HEAD_MARKERS = new Set(["　", "\t", "「", "『", "（", "〈", "《", "【"]);

// 連結時にスペースを挟むかどうかの判定に使う文字集合（英字テキストの単語結合用）。
// どちらか一方でもこの集合に該当しなければ（例: 日本語）、スペースなしで結合する。
const ASCII_JOIN_CHAR_RE = /^[A-Za-z0-9,;:)]$/;

function lastCodePoint(value: string): string {
  const chars = Array.from(value);
  return chars.length > 0 ? chars[chars.length - 1] : "";
}

function firstCodePoint(value: string): string {
  const chars = Array.from(value);
  return chars.length > 0 ? chars[0] : "";
}

// 隣接する2行 A（前）, B（後）の間の改行を <br> として保持すべきかどうか。
function shouldPreserveLineBreak(a: string, b: string): boolean {
  const aTrimmed = a.replace(/[ \t]+$/, "");
  if (aTrimmed.length === 0 || b.length === 0) {
    return true;
  }
  if (SENTENCE_END_CHARS.has(lastCodePoint(aTrimmed))) {
    return true;
  }
  if (PARAGRAPH_HEAD_MARKERS.has(firstCodePoint(b))) {
    return true;
  }
  return false;
}

// A と B を連結するときに挟む文字。
function lineJoinSeparator(a: string, b: string): string {
  const aTrimmed = a.replace(/[ \t]+$/, "");
  const lastChar = lastCodePoint(aTrimmed);
  const firstChar = firstCodePoint(b);
  return ASCII_JOIN_CHAR_RE.test(lastChar) && ASCII_JOIN_CHAR_RE.test(firstChar) ? " " : "";
}

// 空行を含まない1段落ブロック内のハードラップ行を連結する。
function joinLinesInParagraph(paragraph: string): string {
  const lines = paragraph.split("\n");
  let result = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    if (shouldPreserveLineBreak(a, b)) {
      result += "\n" + b;
    } else {
      // preserveSpaces=true でも、連結境界では常に A の行末の半角スペース・
      // タブを取り除いてから結合する。
      result = result.replace(/[ \t]+$/, "") + lineJoinSeparator(a, b) + b;
    }
  }
  return result;
}

// 空行区切りの各段落ブロック内でハードラップ行を連結する。すでに正規化済み
// （改行統一・制御文字除去・連続空行制限済み）のテキストに対して、段落分割・
// <br>変換（textToParagraphHtml）の直前に適用する。
export function joinWrappedLines(text: string): string {
  return text
    .split(/(\n{2,})/)
    .map((chunk, index) => (index % 2 === 0 ? joinLinesInParagraph(chunk) : chunk))
    .join("");
}

export interface NormalizeTextOptions {
  maxConsecutiveBlankLines: number;
  preserveSpaces: boolean;
  joinHardWrappedLines: boolean;
}

export interface NormalizeTextResult {
  text: string;
  controlCharsRemoved: number;
}

// 改行統一 → NFC正規化（§8.2。NFKCは使用しない）→ 制御文字除去 →
// (preserveSpaces=false のときのみ)行末空白除去 → 連続空行の制限 →
// (joinHardWrappedLines=true のときのみ)ハードラップ行の連結、の順で適用する。
export function normalizeText(rawText: string, options: NormalizeTextOptions): NormalizeTextResult {
  let text = normalizeLineEndings(rawText);
  text = text.normalize("NFC");
  const stripped = stripControlChars(text);
  text = stripped.text;
  if (!options.preserveSpaces) {
    text = trimTrailingLineWhitespace(text);
  }
  text = limitConsecutiveBlankLines(text, options.maxConsecutiveBlankLines);
  if (options.joinHardWrappedLines) {
    text = joinWrappedLines(text);
  }
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
