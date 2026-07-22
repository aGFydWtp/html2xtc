// SPDX-License-Identifier: AGPL-3.0-or-later
// WebUIの青空文庫対応（aozora-text-conversion 仕様書 §15）向けの、Svelteコンポーネント
// から切り出した純粋関数群。自動判定・プリセット適用・表題/著者自動入力・診断件数の
// 集計はいずれも副作用を持たないためここでユニットテストできる
// （TextInputPanel.svelte はこれらを呼び出すだけの薄いオーケストレーションにする）。

import {
  detectAozoraFormat,
  MAX_DIAGNOSTICS,
  type AozoraDetectionResult,
  type AozoraDiagnostic,
} from "@html2xtc/aozora-text";
import { applyAozoraPresetIfUntouched } from "./text-options";
import { applyTextPreset, type TextConvertOptions, type TextInputFormat } from "./text-options";

/**
 * inputFormat の自動判定（仕様 §15.2）。ユーザーが一度手動変更していれば
 * (`manuallySet`)、判定結果に関わらず現在値を維持する — 「再判定で上書きしない」。
 * まだ手動変更されていない場合のみ、高信頼判定（detectAozoraFormat の isAozora）で
 * "aozora" へ切り替える。判定が false のときは何もしない（"plain" のままにし、
 * 一度 aozora になったものを勝手に plain へ戻すことはしない — このケースは
 * ファイル読込直後の1回だけ呼ばれる想定のため実際には起こらない）。
 */
export function resolveAutoInputFormat(
  currentFormat: TextInputFormat,
  manuallySet: boolean,
  detection: AozoraDetectionResult,
): TextInputFormat {
  if (manuallySet) {
    return currentFormat;
  }
  return detection.isAozora ? "aozora" : currentFormat;
}

/**
 * ファイル読込完了時の初期化（自動判定 + 初期プリセット適用）をひとつにまとめた
 * 純粋関数。TextInputPanel.svelte の「1ファイルにつき1回だけ」の初期化effectから
 * 呼ぶ。`decodedText` は判定用の生テキスト（デコード直後、正規化前でよい —
 * detectAozoraFormat は部分文字列の出現を見るだけなので改行コードや空白の正規化に
 * 依存しない）。
 */
export function computeInitialTextOptions(
  options: TextConvertOptions,
  decodedText: string,
  manuallySet: boolean,
): TextConvertOptions {
  const format = resolveAutoInputFormat(options.inputFormat, manuallySet, detectAozoraFormat(decodedText));
  const withFormat = format === options.inputFormat ? options : { ...options, inputFormat: format };
  return withFormat.inputFormat === "aozora"
    ? applyAozoraPresetIfUntouched(withFormat)
    : applyTextPreset(withFormat, "standard");
}

/**
 * 表題の自動入力（仕様 §15.4）。表題が「未編集」（空、またはファイル名由来の
 * 自動導出値のまま）の場合のみ、抽出した表題で置き換える。ユーザーが手入力した
 * 値、または抽出結果が空/未検出の場合は現状維持する。100文字上限は
 * TextOptions.svelte の `<input maxlength="100">` と揃える（options.title の
 * バリデーション上限、text-options.ts の validateTextOptions と同じ基準）。
 */
export function resolveAutoFillTitle(
  currentTitle: string,
  autoDerivedTitle: string,
  extractedTitle: string | undefined,
): string {
  if (extractedTitle === undefined) {
    return currentTitle;
  }
  const trimmed = extractedTitle.trim();
  if (trimmed.length === 0) {
    return currentTitle;
  }
  const isUntouched = currentTitle.trim() === "" || currentTitle === autoDerivedTitle;
  return isUntouched ? trimmed.slice(0, 100) : currentTitle;
}

/**
 * 著者の自動入力（仕様 §15.4）。著者欄が空の場合のみ、抽出した著者を設定する。
 */
export function resolveAutoFillAuthor(currentAuthor: string, extractedAuthor: string | undefined): string {
  if (extractedAuthor === undefined) {
    return currentAuthor;
  }
  if (currentAuthor.trim().length > 0) {
    return currentAuthor;
  }
  const trimmed = extractedAuthor.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 100) : currentAuthor;
}

export interface AozoraDiagnosticsSummary {
  unsupportedAnnotations: number;
  malformedAnnotations: number;
  /** src/text-prepare.ts の prepareAozora と同じ集計方法（診断は最大200件保持、
   * これに達していれば実際にはもっと診断があった可能性がある）。 */
  truncated: boolean;
}

/**
 * 診断件数の集計（仕様 §15.5）。src/text-prepare.ts の prepareAozora と同じ分類
 * 基準（バックエンドを直接importできないため意図的に複製 — text-options.ts の
 * FONT_FAMILY_RE と同じ理由）: unsupported-annotation は「未対応の注記」、
 * malformed-annotation/unmatched-end/unclosed-range/ruby-without-base は
 * 「壊れた注記」としてまとめて数える。注記本文そのものは一切保持しない
 * （件数のみ）。
 */
export function summarizeAozoraDiagnostics(diagnostics: readonly AozoraDiagnostic[]): AozoraDiagnosticsSummary {
  let unsupportedAnnotations = 0;
  let malformedAnnotations = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === "unsupported-annotation") {
      unsupportedAnnotations++;
    } else if (
      diagnostic.kind === "malformed-annotation" ||
      diagnostic.kind === "unmatched-end" ||
      diagnostic.kind === "unclosed-range" ||
      diagnostic.kind === "ruby-without-base"
    ) {
      malformedAnnotations++;
    }
  }
  return {
    unsupportedAnnotations,
    malformedAnnotations,
    truncated: diagnostics.length >= MAX_DIAGNOSTICS,
  };
}
