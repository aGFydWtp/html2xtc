// SPDX-License-Identifier: AGPL-3.0-or-later
// TXT変換設定の型・既定値・プリセット・バリデーション（実装仕様書 §6）。

import { encodeBase64UrlUtf8 } from "./pdf-options";

export type TextEncoding = "auto" | "utf-8" | "shift_jis";
export type TextLayout = "horizontal" | "vertical";
export type TextAlign = "start" | "justify";
/** 入力形式（実装仕様書 §5.1）。"plain" が既定・省略時の値で、既存の挙動を
 * バイト同一で維持する。"aozora" は共有パッケージ @html2xtc/aozora-text の
 * AST パーサー/レンダラーを経由する。 */
export type TextInputFormat = "plain" | "aozora";

export interface TextMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TextConvertOptions {
  inputFormat: TextInputFormat;

  encoding: TextEncoding;
  layout: TextLayout;

  /** Google Fontsのfamily名 */
  font: string;

  /** CSS px */
  fontSizePx: number;

  /** 単位なし */
  lineHeight: number;

  /** CSS em */
  paragraphSpacingEm: number;

  margins: TextMargins;

  textAlign: TextAlign;
  maxConsecutiveBlankLines: number;
  preserveSpaces: boolean;

  /** 固定幅ハードラップされた行を段落内で連結するか（text-normalize.ts の joinWrappedLines） */
  joinHardWrappedLines: boolean;

  showPageNumbers: boolean;

  /** 100文字以内 */
  title: string;

  /** 100文字以内 */
  author: string;
}

// §6.2 既定値（inputFormat は実装仕様書 §5.2）
export const DEFAULT_TEXT_OPTIONS: TextConvertOptions = {
  inputFormat: "plain",
  encoding: "auto",
  layout: "horizontal",
  font: "BIZ UDPGothic",
  fontSizePx: 18,
  lineHeight: 1.8,
  paragraphSpacingEm: 0.9,
  margins: {
    top: 36,
    right: 32,
    bottom: 40,
    left: 32,
  },
  textAlign: "start",
  maxConsecutiveBlankLines: 2,
  preserveSpaces: false,
  joinHardWrappedLines: true,
  showPageNumbers: false,
  title: "",
  author: "",
};

// §6.3 縦書き既定値: ユーザーが個別設定を変更していない状態で縦書きへ
// 切り替えた場合のみ適用する。
export const VERTICAL_DEFAULT_OVERRIDES: Pick<TextConvertOptions, "font" | "fontSizePx" | "lineHeight"> = {
  font: "BIZ UDMincho",
  fontSizePx: 18,
  lineHeight: 1.9,
};

// layout 以外の「個別設定」が既定値のままかどうかを判定する（§6.3 の「変更していない」
// の実装: 明示的な touched フラグを持ち回す代わりに、値そのものを既定値と比較する）。
export function isUntouchedFromDefault(options: TextConvertOptions): boolean {
  return (
    options.font === DEFAULT_TEXT_OPTIONS.font &&
    options.fontSizePx === DEFAULT_TEXT_OPTIONS.fontSizePx &&
    options.lineHeight === DEFAULT_TEXT_OPTIONS.lineHeight &&
    options.paragraphSpacingEm === DEFAULT_TEXT_OPTIONS.paragraphSpacingEm &&
    options.margins.top === DEFAULT_TEXT_OPTIONS.margins.top &&
    options.margins.right === DEFAULT_TEXT_OPTIONS.margins.right &&
    options.margins.bottom === DEFAULT_TEXT_OPTIONS.margins.bottom &&
    options.margins.left === DEFAULT_TEXT_OPTIONS.margins.left &&
    options.textAlign === DEFAULT_TEXT_OPTIONS.textAlign &&
    options.maxConsecutiveBlankLines === DEFAULT_TEXT_OPTIONS.maxConsecutiveBlankLines &&
    options.preserveSpaces === DEFAULT_TEXT_OPTIONS.preserveSpaces &&
    options.joinHardWrappedLines === DEFAULT_TEXT_OPTIONS.joinHardWrappedLines
  );
}

// 書字方向を切り替える。縦書きへの切替時、個別設定が既定値のままなら §6.3 の
// 上書きを適用する。横書きへ戻すときは何も上書きしない（仕様書に明示的な既定
// 復帰の指定がないため）。
export function setTextLayout(options: TextConvertOptions, layout: TextLayout): TextConvertOptions {
  if (layout === "vertical" && options.layout !== "vertical" && isUntouchedFromDefault(options)) {
    return { ...options, layout: "vertical", ...VERTICAL_DEFAULT_OVERRIDES };
  }
  return { ...options, layout };
}

// 青空文庫形式選択時の初期設定（aozora-text-conversion 仕様書 §15.3）。layout/font/
// fontSizePx/lineHeight/joinHardWrappedLines のすべてが初期値のままの場合のみ適用する
// （isUntouchedForAozoraPreset）。VERTICAL_DEFAULT_OVERRIDES と値は同じだが、
// joinHardWrappedLines を明示的に false へ寄せる点が異なるため独立した定数にする。
export const AOZORA_PRESET_OVERRIDES: Pick<
  TextConvertOptions,
  "layout" | "font" | "fontSizePx" | "lineHeight" | "joinHardWrappedLines"
> = {
  layout: "vertical",
  font: "BIZ UDMincho",
  fontSizePx: 18,
  lineHeight: 1.9,
  joinHardWrappedLines: false,
};

// isUntouchedFromDefault は layout を見ない（横書き→縦書き切替専用の判定のため）。
// aozora プリセットは layout も含めた5項目すべてが初期値のままかどうかで判定する
// （仕様 §15.3）。
export function isUntouchedForAozoraPreset(options: TextConvertOptions): boolean {
  return (
    options.layout === DEFAULT_TEXT_OPTIONS.layout &&
    options.font === DEFAULT_TEXT_OPTIONS.font &&
    options.fontSizePx === DEFAULT_TEXT_OPTIONS.fontSizePx &&
    options.lineHeight === DEFAULT_TEXT_OPTIONS.lineHeight &&
    options.joinHardWrappedLines === DEFAULT_TEXT_OPTIONS.joinHardWrappedLines
  );
}

// ユーザーが個別設定済み（isUntouchedForAozoraPreset が false）なら何もしない —
// 呼び出し側は inputFormat を "aozora" にした直後、常にこれを通してよい。
export function applyAozoraPresetIfUntouched(options: TextConvertOptions): TextConvertOptions {
  if (!isUntouchedForAozoraPreset(options)) {
    return options;
  }
  return { ...options, ...AOZORA_PRESET_OVERRIDES };
}

// aozora では joinHardWrappedLines は常に無視される（§10.3）。UIの活性・非活性判定に
// 使う純粋関数（TextOptions.svelte から呼ぶ）。
export function isJoinHardWrappedLinesEditable(inputFormat: TextInputFormat): boolean {
  return inputFormat !== "aozora";
}

// §6.5 プリセット
export type TextPresetId = "standard" | "vertical_novel" | "large_font";

type TextPresetPatch = Partial<Pick<TextConvertOptions, "layout" | "font" | "fontSizePx" | "lineHeight">>;

export const TEXT_PRESETS: Record<TextPresetId, TextPresetPatch> = {
  standard: { layout: "horizontal", font: "BIZ UDPGothic", fontSizePx: 18, lineHeight: 1.8 },
  vertical_novel: { layout: "vertical", font: "BIZ UDMincho", fontSizePx: 18, lineHeight: 1.9 },
  large_font: { fontSizePx: 23, lineHeight: 1.8 },
};

export function applyTextPreset(options: TextConvertOptions, preset: TextPresetId): TextConvertOptions {
  return { ...options, ...TEXT_PRESETS[preset] };
}

// --- フォント候補（ユーザー指示: 自由入力ではなく候補選択式） -----------------------
// バックエンド（src/fonts.ts）で 400/700 デュアルウェイト対応済みの BIZ UD 4書体
// （UDGothic / UDPGothic / UDMincho / UDPMincho。P付き=プロポーショナル、Pなし=等幅。
// ゴシック・明朝それぞれで P 有無を選べる）と、日本語書籍向けの定番 Google Fonts を
// 候補にする。
export interface FontCandidate {
  family: string;
  label: string;
}

export const FONT_CANDIDATES: readonly FontCandidate[] = [
  { family: "BIZ UDGothic", label: "BIZ UDGothic" },
  { family: "BIZ UDPGothic", label: "BIZ UDPGothic" },
  { family: "BIZ UDMincho", label: "BIZ UDMincho" },
  { family: "BIZ UDPMincho", label: "BIZ UDPMincho" },
  { family: "Noto Sans JP", label: "Noto Sans JP" },
  { family: "Noto Serif JP", label: "Noto Serif JP" },
  { family: "Zen Maru Gothic", label: "Zen Maru Gothic" },
  { family: "Shippori Mincho", label: "Shippori Mincho" },
];

// バックエンド（src/fonts.ts の sanitizeFontFamily）と同じ許容規則。frontend からは
// src/ を import できないため意図的に複製している — 変更時は両方揃えること
// （実装仕様書 §6.4「既存フォント検証規則」）。
const FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

export function isValidFontFamily(value: string): boolean {
  return value.length > 0 && value.length <= 64 && FONT_FAMILY_RE.test(value);
}

// --- バリデーション（§6.4）。APIでは不正値を暗黙補正せず400で拒否するため、
// UI側でも同じ制約を検証してから送信できるようにする。 --------------------------
export interface TextOptionsValidationError {
  field: string;
  message: string;
}

// UTF-16コードユニット数(string.length)ではなくコードポイント数で数える。
// バックエンド（src/text-options.ts の codePointLength）と同じ基準 — サロゲート
// ペア（絵文字等）を1文字として扱うため。
function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function validateTextOptions(options: TextConvertOptions): TextOptionsValidationError[] {
  const errors: TextOptionsValidationError[] = [];

  if (options.inputFormat !== "plain" && options.inputFormat !== "aozora") {
    errors.push({ field: "inputFormat", message: 'inputFormat must be "plain" or "aozora"' });
  }
  if (options.encoding !== "auto" && options.encoding !== "utf-8" && options.encoding !== "shift_jis") {
    errors.push({ field: "encoding", message: 'encoding must be "auto", "utf-8" or "shift_jis"' });
  }
  if (options.layout !== "horizontal" && options.layout !== "vertical") {
    errors.push({ field: "layout", message: 'layout must be "horizontal" or "vertical"' });
  }
  if (!isValidFontFamily(options.font)) {
    errors.push({ field: "font", message: "font must be a valid font family name (64 chars max)" });
  }
  if (!Number.isFinite(options.fontSizePx) || options.fontSizePx < 12 || options.fontSizePx > 32) {
    errors.push({ field: "fontSizePx", message: "fontSizePx must be between 12 and 32" });
  }
  if (!Number.isFinite(options.lineHeight) || options.lineHeight < 1.2 || options.lineHeight > 2.5) {
    errors.push({ field: "lineHeight", message: "lineHeight must be between 1.2 and 2.5" });
  }
  if (!Number.isFinite(options.paragraphSpacingEm) || options.paragraphSpacingEm < 0 || options.paragraphSpacingEm > 3) {
    errors.push({ field: "paragraphSpacingEm", message: "paragraphSpacingEm must be between 0 and 3" });
  }
  const margins = [
    ["top", options.margins?.top],
    ["right", options.margins?.right],
    ["bottom", options.margins?.bottom],
    ["left", options.margins?.left],
  ] as const;
  for (const [name, v] of margins) {
    if (!Number.isFinite(v) || (v as number) < 0 || (v as number) > 120) {
      errors.push({ field: `margins.${name}`, message: `margins.${name} must be between 0 and 120` });
    }
  }
  if (options.textAlign !== "start" && options.textAlign !== "justify") {
    errors.push({ field: "textAlign", message: 'textAlign must be "start" or "justify"' });
  }
  if (
    !Number.isInteger(options.maxConsecutiveBlankLines) ||
    options.maxConsecutiveBlankLines < 0 ||
    options.maxConsecutiveBlankLines > 5
  ) {
    errors.push({ field: "maxConsecutiveBlankLines", message: "maxConsecutiveBlankLines must be an integer between 0 and 5" });
  }
  if (typeof options.preserveSpaces !== "boolean") {
    errors.push({ field: "preserveSpaces", message: "preserveSpaces must be boolean" });
  }
  if (typeof options.joinHardWrappedLines !== "boolean") {
    errors.push({ field: "joinHardWrappedLines", message: "joinHardWrappedLines must be boolean" });
  }
  if (typeof options.showPageNumbers !== "boolean") {
    errors.push({ field: "showPageNumbers", message: "showPageNumbers must be boolean" });
  }
  if (codePointLength(options.title) > 100) {
    errors.push({ field: "title", message: "title must be 100 characters or fewer" });
  }
  if (codePointLength(options.author) > 100) {
    errors.push({ field: "author", message: "author must be 100 characters or fewer" });
  }

  return errors;
}

export function isValidTextOptions(options: TextConvertOptions): boolean {
  return validateTextOptions(options).length === 0;
}

// --- API送信用ヘッダーエンコード（仕様書 §11.5 X-Text-Options） -------------------
// base64url(UTF-8) エンコード自体は pdf-options.ts の encodeBase64UrlUtf8 を再利用する
// （PDF/TXTで共通のエンコード規則のため — 実装仕様書 §11.5 と §8.1 は同じ方式）。
export function encodeTextOptionsHeader(options: TextConvertOptions): string {
  return encodeBase64UrlUtf8(JSON.stringify(options));
}
