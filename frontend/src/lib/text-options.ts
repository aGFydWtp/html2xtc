// SPDX-License-Identifier: AGPL-3.0-or-later
// TXT変換設定の型・既定値・プリセット・バリデーション（実装仕様書 §6）。

import type { Device } from "./device-tag";
// type-only import: このファイルはランタイムでは i18n に依存しない（既存の分離を保つ）。
import type { Lang } from "./i18n.svelte";
import { encodeBase64UrlUtf8 } from "./pdf-options";

export type TextEncoding = "auto" | "utf-8" | "shift_jis";
export type TextLayout = "horizontal" | "vertical";
export type TextAlign = "start" | "justify";
/** 入力形式（実装仕様書 §5.1、Markdown対応仕様書 §5.1）。"plain" が既定・
 * 省略時の値で、既存の挙動をバイト同一で維持する。"aozora" は共有パッケージ
 * @html2xtc/aozora-text の AST パーサー/レンダラーを経由する。"markdown" は
 * 共有パッケージ @html2xtc/markdown-text の markdown-it ベースのパーサー/
 * 許可リストレンダラーを経由する。 */
export type TextInputFormat = "plain" | "aozora" | "markdown";

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

  /** 変換先 Xteink 機種（src/devices.ts）。省略時サーバー側は "x3" として扱う。 */
  device: Device;
}

// §6.2 既定値（inputFormat は実装仕様書 §5.2）
export const DEFAULT_TEXT_OPTIONS: TextConvertOptions = {
  inputFormat: "plain",
  encoding: "auto",
  layout: "horizontal",
  font: "BIZ UDPGothic",
  fontSizePx: 26,
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
  device: "x3",
};

// UI言語ごとの既定フォント（フロントエンドのみの決定 — TXT/EPUBはfontを常にAPIへ
// 明示送信するため、サーバー側の既定値とは無関係）。"ja" のときだけ日本語UI向けの
// 書体を返し、それ以外（将来言語が増えても）はすべて英語圏の書体へフォールバック
// する構造にする — Lang が3値以上に増えたときに、日本語以外を自動的に英語側へ
// 倒すため。DEFAULT_TEXT_OPTIONS.font（日本語UI向け、既存の既定値のまま）と
// 重複させないよう、そちらを参照する。
export function defaultFontForLang(lang: Lang): string {
  return lang === "ja" ? DEFAULT_TEXT_OPTIONS.font : "Literata";
}

// isUntouchedFromDefault/isUntouchedForAozoraPreset/setTextLayout/
// applyAozoraPresetIfUntouched が「ユーザーが手を付けていないか」を判定する際の
// 比較基準（baseline）。UI言語のみに応じてfontが変わり、他フィールドは
// DEFAULT_TEXT_OPTIONS と同じ。呼び出し元（TextInputPanel.svelte）はマウント時に
// 一度だけこれを作り、初期options自体にも・baseline判定にも同じ値を使う。
export function defaultTextOptionsForLang(lang: Lang): TextConvertOptions {
  return { ...DEFAULT_TEXT_OPTIONS, font: defaultFontForLang(lang), margins: { ...DEFAULT_TEXT_OPTIONS.margins } };
}

// §6.3 縦書き既定値: ユーザーが個別設定を変更していない状態で縦書きへ
// 切り替えた場合のみ適用する。縦書きは日本語前提のため、UI言語に関わらず
// BIZ UDMincho 固定（言語別にしない）。
export const VERTICAL_DEFAULT_OVERRIDES: Pick<TextConvertOptions, "font" | "fontSizePx" | "lineHeight"> = {
  font: "BIZ UDMincho",
  fontSizePx: 26,
  lineHeight: 1.9,
};

// layout 以外の「個別設定」が baseline（その環境の初期値。通常は
// defaultTextOptionsForLang(lang) の戻り値）のままかどうかを判定する（§6.3 の
// 「変更していない」の実装: 明示的な touched フラグを持ち回す代わりに、値そのものを
// baseline と比較する）。「未タッチ」の基準はUI言語ごとに異なりうる（fontの既定値が
// 変わるため）ので、固定定数ではなく引数で受け取る — 呼び出し元が渡し忘れると
// 静かに旧挙動へ戻ることを避けるため、baseline は省略不可の必須引数にしてある。
export function isUntouchedFromDefault(options: TextConvertOptions, baseline: TextConvertOptions): boolean {
  return (
    options.font === baseline.font &&
    options.fontSizePx === baseline.fontSizePx &&
    options.lineHeight === baseline.lineHeight &&
    options.paragraphSpacingEm === baseline.paragraphSpacingEm &&
    options.margins.top === baseline.margins.top &&
    options.margins.right === baseline.margins.right &&
    options.margins.bottom === baseline.margins.bottom &&
    options.margins.left === baseline.margins.left &&
    options.textAlign === baseline.textAlign &&
    options.maxConsecutiveBlankLines === baseline.maxConsecutiveBlankLines &&
    options.preserveSpaces === baseline.preserveSpaces &&
    options.joinHardWrappedLines === baseline.joinHardWrappedLines
  );
}

// 書字方向を切り替える。縦書きへの切替時、個別設定が baseline のままなら §6.3 の
// 上書きを適用する。横書きへ戻すときは何も上書きしない（仕様書に明示的な既定
// 復帰の指定がないため）。
export function setTextLayout(options: TextConvertOptions, layout: TextLayout, baseline: TextConvertOptions): TextConvertOptions {
  if (layout === "vertical" && options.layout !== "vertical" && isUntouchedFromDefault(options, baseline)) {
    return { ...options, layout: "vertical", ...VERTICAL_DEFAULT_OVERRIDES };
  }
  return { ...options, layout };
}

// 青空文庫形式選択時の初期設定（aozora-text-conversion 仕様書 §15.3）。layout/font/
// fontSizePx/lineHeight/joinHardWrappedLines のすべてが baseline のままの場合のみ
// 適用する（isUntouchedForAozoraPreset）。VERTICAL_DEFAULT_OVERRIDES と値は同じだが、
// joinHardWrappedLines を明示的に false へ寄せる点が異なるため独立した定数にする。
// 青空文庫は日本語前提のため、UI言語に関わらず BIZ UDMincho 固定（言語別にしない）。
export const AOZORA_PRESET_OVERRIDES: Pick<
  TextConvertOptions,
  "layout" | "font" | "fontSizePx" | "lineHeight" | "joinHardWrappedLines"
> = {
  layout: "vertical",
  font: "BIZ UDMincho",
  fontSizePx: 26,
  lineHeight: 1.9,
  joinHardWrappedLines: false,
};

// isUntouchedFromDefault は layout を見ない（横書き→縦書き切替専用の判定のため）。
// aozora プリセットは layout も含めた5項目すべてが baseline のままかどうかで判定する
// （仕様 §15.3）。baseline は isUntouchedFromDefault と同じ理由で必須引数にする
// （渡し忘れによる旧挙動への static fallback を型で防ぐ）。
export function isUntouchedForAozoraPreset(options: TextConvertOptions, baseline: TextConvertOptions): boolean {
  return (
    options.layout === baseline.layout &&
    options.font === baseline.font &&
    options.fontSizePx === baseline.fontSizePx &&
    options.lineHeight === baseline.lineHeight &&
    options.joinHardWrappedLines === baseline.joinHardWrappedLines
  );
}

// ユーザーが個別設定済み（isUntouchedForAozoraPreset が false）なら何もしない —
// 呼び出し側は inputFormat を "aozora" にした直後、常にこれを通してよい。
export function applyAozoraPresetIfUntouched(options: TextConvertOptions, baseline: TextConvertOptions): TextConvertOptions {
  if (!isUntouchedForAozoraPreset(options, baseline)) {
    return options;
  }
  return { ...options, ...AOZORA_PRESET_OVERRIDES };
}

// aozora・markdown では joinHardWrappedLines は常に無視される（§10.3、Markdown対応
// 仕様書 §8「Markdownでは次のオプションを無視する」）。UIの活性・非活性判定に使う
// 純粋関数（TextOptions.svelte から呼ぶ）。
export function isJoinHardWrappedLinesEditable(inputFormat: TextInputFormat): boolean {
  return inputFormat !== "aozora" && inputFormat !== "markdown";
}

// Markdownでは改行・空白・インデント自体が構文であるため、正規化系オプションのうち
// maxConsecutiveBlankLines と preserveSpaces も無視される（Markdown対応仕様書 §8）。
// aozora はこの2つを無視しない（joinHardWrappedLinesのみ無視、上の関数）ため、
// isJoinHardWrappedLinesEditable とは別の判定関数にする。
export function isMaxConsecutiveBlankLinesEditable(inputFormat: TextInputFormat): boolean {
  return inputFormat !== "markdown";
}

export function isPreserveSpacesEditable(inputFormat: TextInputFormat): boolean {
  return inputFormat !== "markdown";
}

// ファイル名が .md/.markdown かどうか（大文字小文字を区別しない）。自動判定
// （Markdown対応仕様書 §5.4）と添付バッジ表示（§17.4）の両方で使う共通判定。
const MARKDOWN_FILE_NAME_RE = /\.(?:md|markdown)$/i;

export function isMarkdownFileName(name: string): boolean {
  return MARKDOWN_FILE_NAME_RE.test(name);
}

// §6.5 プリセット
export type TextPresetId = "standard" | "vertical_novel" | "large_font";

type TextPresetPatch = Partial<Pick<TextConvertOptions, "layout" | "font" | "fontSizePx" | "lineHeight">>;

// "standard" の font はUI言語に応じて変える（英語UIで「標準」を押して日本語書体に
// 戻るのは不自然なため）。"vertical_novel" は縦書き前提のプリセットなので
// BIZ UDMincho 固定（言語別にしない）。プリセット定義がfontを含む以上、静的な
// オブジェクトのままでは言語別にできないため関数化してある。
export function textPresetsForLang(lang: Lang): Record<TextPresetId, TextPresetPatch> {
  return {
    standard: { layout: "horizontal", font: defaultFontForLang(lang), fontSizePx: 26, lineHeight: 1.8 },
    vertical_novel: { layout: "vertical", font: "BIZ UDMincho", fontSizePx: 26, lineHeight: 1.9 },
    large_font: { fontSizePx: 30, lineHeight: 1.8 },
  };
}

export function applyTextPreset(options: TextConvertOptions, preset: TextPresetId, lang: Lang): TextConvertOptions {
  return { ...options, ...textPresetsForLang(lang)[preset] };
}

// --- フォント候補（ユーザー指示: 自由入力ではなく候補選択式） -----------------------
// バックエンド（src/fonts.ts）で 400/700 デュアルウェイト対応済みの BIZ UD 4書体
// （UDGothic / UDPGothic / UDMincho / UDPMincho。P付き=プロポーショナル、Pなし=等幅。
// ゴシック・明朝それぞれで P 有無を選べる）と、日本語書籍向けの定番 Google Fonts、
// 加えて英語圏で定番の Google Fonts を候補にする。
export interface FontCandidate {
  family: string;
  label: string;
}

const JA_FONT_CANDIDATES: readonly FontCandidate[] = [
  { family: "BIZ UDGothic", label: "BIZ UDGothic" },
  { family: "BIZ UDPGothic", label: "BIZ UDPGothic" },
  { family: "BIZ UDMincho", label: "BIZ UDMincho" },
  { family: "BIZ UDPMincho", label: "BIZ UDPMincho" },
  { family: "Noto Sans JP", label: "Noto Sans JP" },
  { family: "Noto Serif JP", label: "Noto Serif JP" },
  { family: "Zen Maru Gothic", label: "Zen Maru Gothic" },
  { family: "Shippori Mincho", label: "Shippori Mincho" },
];

const EN_FONT_CANDIDATES: readonly FontCandidate[] = [
  { family: "Literata", label: "Literata" },
  { family: "Merriweather", label: "Merriweather" },
  { family: "EB Garamond", label: "EB Garamond" },
  { family: "Inter", label: "Inter" },
];

// 除外はしない — 両言語で全12書体が選べる。並び順のみ言語で変える。日本語UIは
// 既存の並び順のまま（日本語8書体→英語4書体）。
export const FONT_CANDIDATES: readonly FontCandidate[] = [...JA_FONT_CANDIDATES, ...EN_FONT_CANDIDATES];

// UI言語に応じた候補の並び順。"ja" のときだけ日本語UI向けの並び（既存のまま）を
// 返し、それ以外は英語圏の書体を先頭にする — defaultFontForLang と同じ
// フォールバック構造（Lang が増えてもここを触らずに済む）。
export function fontCandidatesForLang(lang: Lang): readonly FontCandidate[] {
  return lang === "ja" ? FONT_CANDIDATES : [...EN_FONT_CANDIDATES, ...JA_FONT_CANDIDATES];
}

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

  if (options.inputFormat !== "plain" && options.inputFormat !== "aozora" && options.inputFormat !== "markdown") {
    errors.push({ field: "inputFormat", message: 'inputFormat must be "plain", "aozora" or "markdown"' });
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
  if (options.device !== "x3" && options.device !== "x4") {
    errors.push({ field: "device", message: 'device must be "x3" or "x4"' });
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
