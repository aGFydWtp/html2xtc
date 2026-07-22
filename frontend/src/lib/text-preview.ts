// SPDX-License-Identifier: AGPL-3.0-or-later
// 本文プレビュー・X3ページプレビューの構築（実装仕様書 §9.1, §9.3-9.7, §10.6, §10.7,
// aozora-text-conversion 仕様書 §14.2）。

import { separateDocumentStructure, tokenizeAozoraChunk } from "@html2xtc/aozora-text";
import type { TextInputFormat } from "./text-options";

// --- 実機(XTC)プレビュー用の本文抽出（プレビュー仕様書 §5、aozora仕様書 §14.2） ---
// POST /preview/text へ送る前にクライアント側で先頭部分だけを切り出す。サーバー側
// でも同じ上限（MAX_TEXT_PREVIEW_CODE_POINTS/UTF8_BYTES、src/preview/text-preview.ts）
// で再検証されるため、ここでの抽出はあくまで「送信量を削る」ための一次防御であり、
// 信頼はしていない（仕様書 §5.3）。
export const PREVIEW_TARGET_CHARS = 800;
export const PREVIEW_MAX_CHARS = 1_000;

/** サーバー側の上限（src/preview/text-preview.ts の
 * MAX_TEXT_PREVIEW_CODE_POINTS/MAX_TEXT_PREVIEW_UTF8_BYTES）と同じ値。バックエンドと
 * フロントエンドは別ビルドのため定数を共有できず、意図的に複製している — 通常は
 * PREVIEW_MAX_CHARS(1,000) の抽出がこの上限に達することはないが（aozora仕様書
 * §14.2の(5)）、安全網として保持する。 */
const SERVER_MAX_CODE_POINTS = 4_000;
const SERVER_MAX_UTF8_BYTES = 32 * 1024;

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
function selectPlainTextPreview(normalized: string): string {
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

// --- aozora 用の安全な切り出し（aozora-text-conversion 仕様書 §14.2） --------------
//
// 共有パッケージ @html2xtc/aozora-text の関数を再利用し、パーサーを複製しない:
// - separateDocumentStructure: 標準ヘッダ（表題/著者）・記号説明ブロック・底本を
//   本文から分離する（表題/著者は options 経由で渡されるため、ここで本文へ再付加
//   しない — buildTextXtcPreviewCacheKey/requestTextXtcPreview は options をその
//   まま送信する）。
// - tokenizeAozoraChunk: ｜《…》／［＃…］ の字句解析。この関数自体の出力（トークン
//   列）から各トークンの元テキスト長を再構成して開始/終了位置を求める — 正規表現や
//   括弧探索ロジックそのものを複製することはしない。

/** 一つの注記本体が持ちうる最大長（packages/aozora-text/src/types.ts の
 * MAX_ANNOTATION_CODEPOINTS）。安全境界の探索窓をこの値だけ余分に確保しておけば、
 * PREVIEW_MAX_CHARS 付近で始まり候補窓を超えて閉じる注記も見逃さない。 */
const MAX_ANNOTATION_SPAN_CODEPOINTS = 4_096;

/** tokenizeAozoraChunk を呼ぶ範囲を候補切り出し位置近傍だけに絞るための余裕
 * （UTF-16 コード単位）。全文（最大5MiB）を毎回トークナイズしないための境界。
 * サロゲートペア対策で×2。 */
const SCAN_PREFIX_UNITS = (PREVIEW_MAX_CHARS + MAX_ANNOTATION_SPAN_CODEPOINTS) * 2;

/** tokenizeAozoraChunk の最後のトークンが未閉鎖の《…》／［＃…］であれば、その
 * 開始位置まで切り詰める（仕様(3)）。未閉鎖トークンは常に文字列末尾まで消費する
 * ため（tokenize.ts の実装）、存在すれば必ず最後のトークンになる。 */
function stripDanglingSpan(text: string): string {
  const tokens = tokenizeAozoraChunk(text);
  const last = tokens[tokens.length - 1];
  if (last === undefined) return text;
  if (last.type === "unclosedRuby" || last.type === "unclosedAnnotation") {
    return text.slice(0, text.length - last.raw.length);
  }
  return text;
}

/** 「ここから…」で始まり同じ深さの「ここで…終わり」で閉じられていない範囲注記が
 * あれば、その開始位置まで切り詰める（仕様(4)）。ネストに対応するためスタックで
 * 追跡し、閉じられていない最も外側の開始位置まで戻す（内側の注記も一緒に除外
 * される）。 */
function stripUnclosedRange(text: string): string {
  const tokens = tokenizeAozoraChunk(text);
  const openStarts: number[] = [];
  let pos = 0;
  for (const tok of tokens) {
    switch (tok.type) {
      case "text":
        pos += tok.value.length;
        break;
      case "pipe":
        pos += 1;
        break;
      case "ruby":
        pos += tok.reading.length + 2; // "《" + reading + "》"
        break;
      case "unclosedRuby":
      case "unclosedAnnotation":
        pos += tok.raw.length;
        break;
      case "annotation": {
        const start = pos;
        if (tok.body.startsWith("ここから")) {
          openStarts.push(start);
        } else if (tok.body.startsWith("ここで") && openStarts.length > 0) {
          openStarts.pop();
        }
        pos += tok.body.length + 3; // "［＃" + body + "］"
        break;
      }
    }
  }
  return openStarts.length > 0 ? text.slice(0, openStarts[0]) : text;
}

/** サーバー上限（4,000コードポイント/32KiB）を守るための最終安全網
 * （仕様(5)）。通常の PREVIEW_MAX_CHARS(1,000) 抽出では到達しないが、縮めた
 * 場合は再度 stripDanglingSpan/stripUnclosedRange を適用して境界の安全性を
 * 保つ。 */
function enforceAozoraServerLimits(text: string): string {
  let chars = Array.from(text);
  if (chars.length > SERVER_MAX_CODE_POINTS) {
    chars = chars.slice(0, SERVER_MAX_CODE_POINTS);
  }
  let candidate = chars.join("");
  while (chars.length > 0 && new TextEncoder().encode(candidate).byteLength > SERVER_MAX_UTF8_BYTES) {
    chars = chars.slice(0, Math.max(0, chars.length - 100));
    candidate = chars.join("");
  }
  if (candidate.length === text.length) {
    return text;
  }
  return stripUnclosedRange(stripDanglingSpan(candidate));
}

function selectAozoraTextPreview(normalized: string): string {
  const structure = separateDocumentStructure(normalized.split("\n"));
  const body = structure.bodyLines.join("\n");
  if (body.length === 0) {
    return "";
  }

  // 全文が短い場合は無条件で本文全体を対象にする（tokenizeAozoraChunk に
  // 渡す範囲を絞るため、まず候補窓に収まる分だけ codepoint 配列化する）。
  const prefix = body.slice(0, SCAN_PREFIX_UNITS);
  const chars = Array.from(prefix); // コードポイント単位（サロゲート安全）

  if (body.length <= SCAN_PREFIX_UNITS && chars.length <= PREVIEW_TARGET_CHARS) {
    return body;
  }

  const maxChars = Math.min(PREVIEW_MAX_CHARS, chars.length);
  const window = chars.slice(PREVIEW_TARGET_CHARS, maxChars).join("");
  const paragraphBreak = window.match(/\n{2,}/);

  let cutoff: number;
  if (paragraphBreak?.index !== undefined) {
    cutoff = PREVIEW_TARGET_CHARS + paragraphBreak.index;
  } else {
    // (2) 行末優先の安全境界へ戻す: 段落末が見つからず PREVIEW_MAX_CHARS で
    // 打ち切る場合、[TARGET, maxChars) の範囲内で直前の行末（改行）まで戻す。
    // 見つからなければ元の打ち切り位置のまま（従来の plain と同じ挙動）。
    cutoff = maxChars;
    for (let i = maxChars - 1; i >= PREVIEW_TARGET_CHARS; i--) {
      if (chars[i] === "\n") {
        cutoff = i;
        break;
      }
    }
  }

  let candidate = chars.slice(0, cutoff).join("");
  if (paragraphBreak?.index === undefined) {
    candidate = candidate.replace(/[ \t]+$/, "");
  }

  // (3)/(4) 《…》／［＃…］の途中で切らない・未閉鎖の開始注記の手前まで戻す。
  candidate = stripUnclosedRange(stripDanglingSpan(candidate));

  // (5) サーバー上限（4,000cp/32KiB）を守る最終安全網。
  return enforceAozoraServerLimits(candidate);
}

/** X3実機プレビュー用の本文抽出。`inputFormat` が `"aozora"` のときは共有パッケージ
 * `@html2xtc/aozora-text` の関数を使い、標準ヘッダ・記号説明の分離、《…》／
 * ［＃…］の途中で切らない安全境界、未閉鎖の開始注記の手前への巻き戻しを行う
 * （aozora-text-conversion 仕様書 §14.2）。`"plain"`（省略時含む既定）は既存の
 * 挙動をそのまま維持する。 */
export function selectTextPreview(fullText: string, inputFormat: TextInputFormat = "plain"): string {
  const normalized = fullText.replace(/\r\n|\r/g, "\n");
  return inputFormat === "aozora" ? selectAozoraTextPreview(normalized) : selectPlainTextPreview(normalized);
}
