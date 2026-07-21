// SPDX-License-Identifier: AGPL-3.0-or-later
// i18n。LANG_KEY は about.html（静的ページ）と共通で、言語選択が両ページ間で引き継がれる。

export type Lang = "ja" | "en";

export type JobStatus = "queued" | "rendering" | "converting" | "completed" | "failed" | "expired";

export interface Messages {
  brand: string;
  intro: string;
  convert: string;
  keep_layout: string;
  form_note: string;
  agree_before: string;
  agree_link: string;
  agree_after: string;
  history: string;
  clear_all: string;
  about_link: string;
  copyright_line: string;
  dl: string;
  menu_label: string;
  menu_dl: string;
  menu_preview: string;
  preview: string;
  preview_prev: string;
  preview_next: string;
  preview_close: string;
  preview_retry: string;
  preview_loading: string;
  preview_page: (n: number, total: number) => string;
  preview_expired: string;
  preview_parse_fail: string;
  confirm_clear: string;
  poll_fail: string;
  no_server: string;
  http_error: (s: number) => string;
  pdf_too_large: string;
  aozora_open: string;
  aozora_title: string;
  aozora_hint: string;
  cancel: string;
  aozora_start: string;
  aozora_searching: string;
  aozora_empty: string;
  aozora_fail: string;
  aozora_results: (n: number) => string;
  aozora_selected: (n: number, max: number) => string;
  aozora_convert: (n: number) => string;
  status: Record<JobStatus, string>;
}

export const I18N: Record<Lang, Messages> = {
  ja: {
    brand: "XTC 変換",
    intro: "公開されているWebサイトやコンテンツを、電子ペーパー端末 Xteink X3 用の XTC ファイルに変換します。",
    convert: "変換する",
    keep_layout: "レイアウトを保持して変換する",
    form_note: "変換には 1〜2 分ほどかかります。生成されたファイルは約 24 時間後に自動削除されます。",
    agree_before: "「変換する」を押すことで、",
    agree_link: "利用規約",
    agree_after: "に同意したものとします。",
    history: "履歴",
    clear_all: "すべて削除",
    about_link: "このサービスについて",
    copyright_line: "© 2026 aGFydWtp",
    dl: "XTC をダウンロード",
    menu_label: "操作メニュー",
    menu_dl: "XTC ダウンロード",
    menu_preview: "XTC プレビュー",
    preview: "プレビュー",
    preview_prev: "前へ",
    preview_next: "次へ",
    preview_close: "閉じる",
    preview_retry: "再試行",
    preview_loading: "読み込み中…",
    preview_page: (n, total) => `${n} / ${total} ページ`,
    preview_expired: "保存期限が切れているため、プレビューできません。",
    preview_parse_fail: "XTC ファイルを解析できませんでした。",
    confirm_clear: "履歴をすべて削除しますか？（サーバー上のファイルは削除されません）",
    poll_fail: "状態の取得に失敗しました。ページを再読み込みしてください。",
    no_server: "サーバーに接続できません。",
    http_error: (s) => `エラー (HTTP ${s})`,
    pdf_too_large: "生成された PDF がサイズ上限を超えました。「レイアウトを保持して変換する」を有効にすると変換できる場合があります。",
    aozora_open: "青空文庫から選択",
    aozora_title: "青空文庫から選択",
    aozora_hint: "タイトル・作者名で検索できます",
    cancel: "キャンセル",
    aozora_start: "作品名か作者名を入力してください。",
    aozora_searching: "検索中…",
    aozora_empty: "該当する作品が見つかりませんでした。",
    aozora_fail: "検索に失敗しました。時間をおいてお試しください。",
    aozora_results: (n) => `検索結果 · ${n}件`,
    aozora_selected: (n, max) => `${n} / ${max} 件選択中`,
    aozora_convert: (n) => n > 0 ? `${n} 件を変換する` : "変換する",
    status: { queued: "待機中", rendering: "PDF 生成中", converting: "XTC 変換中", completed: "✓ 完了", failed: "失敗", expired: "期限切れ" },
  },
  en: {
    brand: "XTC Converter",
    intro: "Converts publicly available websites and content into XTC files for the Xteink X3 e-paper reader.",
    convert: "Convert",
    keep_layout: "Keep the page layout",
    form_note: "Conversion takes 1–2 minutes. Files are deleted automatically after about 24 hours.",
    agree_before: "By pressing “Convert”, you agree to the ",
    agree_link: "Terms of Use",
    agree_after: ".",
    history: "History",
    clear_all: "Clear all",
    about_link: "About this service",
    copyright_line: "© 2026 aGFydWtp",
    dl: "Download XTC",
    menu_label: "Actions",
    menu_dl: "Download XTC",
    menu_preview: "Preview XTC",
    preview: "Preview",
    preview_prev: "Prev",
    preview_next: "Next",
    preview_close: "Close",
    preview_retry: "Retry",
    preview_loading: "Loading…",
    preview_page: (n, total) => `Page ${n} / ${total}`,
    preview_expired: "The file has expired and can no longer be previewed.",
    preview_parse_fail: "Could not parse the XTC file.",
    confirm_clear: "Delete all history? (Files on the server are not deleted.)",
    poll_fail: "Failed to fetch status. Please reload the page.",
    no_server: "Could not reach the server.",
    http_error: (s) => `Error (HTTP ${s})`,
    pdf_too_large: "The rendered PDF exceeds the size limit. Enabling “Keep the page layout” may allow the conversion to succeed.",
    aozora_open: "Choose from Aozora Bunko",
    aozora_title: "Choose from Aozora Bunko",
    aozora_hint: "Search by title or author",
    cancel: "Cancel",
    aozora_start: "Type a title or author name.",
    aozora_searching: "Searching…",
    aozora_empty: "No matching works found.",
    aozora_fail: "Search failed. Please try again later.",
    aozora_results: (n) => `Results · ${n}`,
    aozora_selected: (n, max) => `${n} / ${max} selected`,
    aozora_convert: (n) => n > 0 ? `Convert ${n} selected` : "Convert",
    status: { queued: "Queued", rendering: "Rendering PDF", converting: "Converting to XTC", completed: "✓ Done", failed: "Failed", expired: "Expired" },
  },
};

const LANG_KEY = "xtc-lang";

const state = $state<{ lang: Lang }>({
  lang: localStorage.getItem(LANG_KEY) === "en" ? "en" : "ja",
});
document.documentElement.lang = state.lang;

export function getLang(): Lang {
  return state.lang;
}

export function setLang(next: Lang): void {
  state.lang = next;
  localStorage.setItem(LANG_KEY, next);
  document.documentElement.lang = next;
}

export function t<K extends keyof Messages>(key: K): Messages[K] {
  return I18N[state.lang][key];
}

// note は i18n キー、またはパラメータ付きメッセージの {key, args}。
// 言語切替時に再解決できるよう、未翻訳のまま保持して表示時に noteText() で解決する。
export type NoteKey = "no_server" | "poll_fail" | "preview_expired" | "preview_parse_fail";
export type Note = NoteKey | { key: "http_error"; args: [number] };

export function noteKey(note: Note): string {
  return typeof note === "string" ? note : note.key;
}

export function noteText(note: Note): string {
  if (typeof note === "string") return t(note);
  return t(note.key)(...note.args);
}

// サーバーのエラー文字列は未翻訳で届きそのまま表示されるが、既知のものは i18n キーへ
// 写像して言語切替に追従させる。サイズ超過メッセージは安定した前方部分でマッチする
// （バイト値は MAX_PDF_BYTES の設定に追従する）。未知のものはそのまま表示。
export function serverErrorText(err: string): string {
  if (/rendered PDF exceeds the \d+ byte limit/.test(err)) return t("pdf_too_large");
  return err;
}

// 未知のステータス値はそのまま表示する（サーバー側が先行して新ステータスを返した場合の保険）
export function statusLabel(status: string): string {
  const table = t("status");
  return Object.hasOwn(table, status) ? table[status as JobStatus] : String(status);
}
