// SPDX-License-Identifier: AGPL-3.0-or-later
// PDF 対象ページ範囲の構文（仕様書 §5.4）。
//
// 許可する構文:
//   1 / 1-10 / 1,3,5 / 1-4,7,10-12 / 5- / -3 / 1-
// 不正:
//   0 / -0 / 3-1 / 1,,3 / 1-a / 1-3-5
//
// "5-" は「5ページ目から最終ページまで」、"-3" は「1ページ目から3ページ目まで」、
// "1-" は「全ページ」。同じページが重複指定された場合は最初の出現だけを採用する
// （宣言順を保持したまま重複だけ取り除く。ソートはしない）。

export const MAX_SELECTED_PDF_PAGES = 700;

export class PageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageRangeError";
  }
}

// 1 トークンぶんの構文（"1" または "1-10" / "5-" / "-3"）。
// 全体を跨ぐ "-" は 1 個だけ許可（"1-3-5" は不正）。
const TOKEN_RE = /^(\d+)?-(\d+)?$|^(\d+)$/;

interface Token {
  start: number | null;
  end: number | null;
}

// pageCount に依存しない構文だけの検証（フォーム入力中のインラインエラー表示用）。
export function isValidPagesSyntax(spec: string): boolean {
  try {
    parseTokens(spec);
    return true;
  } catch {
    return false;
  }
}

function parseTokens(spec: string): Token[] {
  const trimmed = spec.trim();
  if (!trimmed) throw new PageRangeError("empty pages spec");

  const rawTokens = trimmed.split(",");
  const tokens: Token[] = [];
  for (const raw of rawTokens) {
    const s = raw.trim();
    if (!s) throw new PageRangeError("empty token"); // "1,,3" 対策
    const m = TOKEN_RE.exec(s);
    if (!m) throw new PageRangeError(`invalid token: ${s}`);
    if (m[3] !== undefined) {
      // 単一ページ "1"
      const n = Number(m[3]);
      if (n < 1) throw new PageRangeError(`page must be >= 1: ${s}`);
      tokens.push({ start: n, end: n });
      continue;
    }
    const startStr = m[1];
    const endStr = m[2];
    if (startStr === undefined && endStr === undefined) throw new PageRangeError(`invalid token: ${s}`);
    const start = startStr === undefined ? null : Number(startStr);
    const end = endStr === undefined ? null : Number(endStr);
    if (start !== null && start < 1) throw new PageRangeError(`page must be >= 1: ${s}`); // "-0" 対策(start=0)
    if (end !== null && end < 1) throw new PageRangeError(`page must be >= 1: ${s}`);
    if (start !== null && end !== null && start > end) throw new PageRangeError(`reversed range: ${s}`); // "3-1" 対策
    tokens.push({ start, end });
  }
  return tokens;
}

// spec と実ページ数から、変換対象ページ番号（1始まり）の配列を返す。
// 宣言順を保持したまま重複を除去し、pageCount を超えるページ番号は無視する。
// 選択ページが 0 件、または maxSelectedPages を超える場合は PageRangeError を投げる。
export function resolvePageNumbers(
  spec: string,
  pageCount: number,
  maxSelectedPages: number = MAX_SELECTED_PDF_PAGES,
): number[] {
  const tokens = parseTokens(spec);
  const seen = new Set<number>();
  const result: number[] = [];
  for (const { start, end } of tokens) {
    const from = start ?? 1;
    const to = end ?? pageCount;
    for (let p = from; p <= to; p++) {
      if (p > pageCount) break; // ページ数外は無視
      if (seen.has(p)) continue; // 重複は最初の出現だけ採用
      seen.add(p);
      result.push(p);
    }
  }
  if (result.length === 0) throw new PageRangeError("no pages selected");
  if (result.length > maxSelectedPages) throw new PageRangeError(`too many pages selected: ${result.length}`);
  return result;
}
