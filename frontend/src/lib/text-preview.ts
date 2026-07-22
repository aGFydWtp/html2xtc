// SPDX-License-Identifier: AGPL-3.0-or-later
// 本文プレビュー・X3ページプレビューの構築（実装仕様書 §9.1, §9.3-9.7, §10.6, §10.7）。

// --- 実機(XTC)プレビュー用の本文抽出（プレビュー仕様書 §5） ---------------------
// POST /preview/text へ送る前にクライアント側で先頭部分だけを切り出す。サーバー側
// でも同じ上限（MAX_TEXT_PREVIEW_CODE_POINTS/UTF8_BYTES、src/preview/text-preview.ts）
// で再検証されるため、ここでの抽出はあくまで「送信量を削る」ための一次防御であり、
// 信頼はしていない（仕様書 §5.3）。
export const PREVIEW_TARGET_CHARS = 800;
export const PREVIEW_MAX_CHARS = 1_000;

/**
 * 抽出規則（仕様書 §5.1）:
 * 1. 全文が PREVIEW_TARGET_CHARS 以下ならそのまま全文
 * 2. それを超える場合、PREVIEW_TARGET_CHARS 以降で最初に来る段落末（空行、
 *    つまり "\n\n"）まで延長する
 * 3. ただし PREVIEW_MAX_CHARS を超えない
 * 4. PREVIEW_MAX_CHARS までに段落末が見つからなければ PREVIEW_MAX_CHARS で
 *    打ち切る
 * 5. Unicode サロゲートペアを分断しない（コードポイント単位で数える・切る）
 * 6. 呼び出し側は CRLF 正規化済みの文字列を渡す想定（本関数はさらに保険として
 *    \r\n/\r を \n へ正規化してから処理する）
 *
 * 打ち切った場合でも省略記号などは付加しない（仕様書 §10 「途中で切れていても
 * 省略記号を自動追加しない」）。
 */
export function selectTextPreview(fullText: string): string {
  const normalized = fullText.replace(/\r\n|\r/g, "\n");
  const chars = Array.from(normalized); // コードポイント単位（サロゲート安全)

  if (chars.length <= PREVIEW_TARGET_CHARS) {
    return normalized;
  }

  const maxChars = Math.min(PREVIEW_MAX_CHARS, chars.length);

  // PREVIEW_TARGET_CHARS 以降、maxChars までの範囲で最初の段落末（"\n\n"、
  // 3行以上の空行連続も含む）を探す。段落末はその区切りの直前までを含める
  // （空行自体はプレビュー本文に含めない）。
  const window = chars.slice(PREVIEW_TARGET_CHARS, maxChars).join("");
  const paragraphBreak = window.match(/\n{2,}/);
  if (paragraphBreak?.index !== undefined) {
    const cutoff = PREVIEW_TARGET_CHARS + paragraphBreak.index;
    return chars.slice(0, cutoff).join("");
  }

  // 段落末が見つからず PREVIEW_MAX_CHARS で打ち切る場合、行の途中の空白で
  // 終わることがある（改行そのものは変更しない — 打ち切り由来の末尾空白のみ
  // 除去する）。
  return chars.slice(0, maxChars).join("").replace(/[ \t]+$/, "");
}
