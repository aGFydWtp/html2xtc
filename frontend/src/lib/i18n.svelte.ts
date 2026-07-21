// SPDX-License-Identifier: AGPL-3.0-or-later
// i18n。LANG_KEY は about.html（静的ページ）と共通で、言語選択が両ページ間で引き継がれる。

import { resolveServerErrorKey } from "./server-error-text";

export type Lang = "ja" | "en";

export type JobStatus = "queued" | "rendering" | "converting" | "completed" | "failed" | "expired";

export interface Messages {
  brand: string;
  intro: string;
  convert: string;
  agree_before: string;
  agree_link: string;
  agree_after: string;
  history: string;
  clear_all: string;
  about_link: string;
  copyright_line: string;
  dl: string;
  menu_label: string;
  menu_open: string;
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

  // --- PDFアップロード入力（実装仕様書 §7, §14） -----------------------------
  pdf_or_drop: string;
  pdf_pick_file: string;
  pdf_drop_active: string;
  pdf_file_label: string;
  pdf_size_label: string;
  pdf_pages_label: string;
  pdf_remove_file: string;
  pdf_preview_note: string;
  pdf_mode_source: string;
  pdf_mode_x3: string;
  pdf_page_indicator: (n: number, total: number) => string;
  pdf_target_pages: string;
  pdf_pages_hint: string;
  pdf_rotation: string;
  pdf_fit: string;
  pdf_fit_contain: string;
  pdf_fit_cover: string;
  pdf_margin: string;
  pdf_advanced: string;
  pdf_crop: string;
  pdf_crop_top: string;
  pdf_crop_right: string;
  pdf_crop_bottom: string;
  pdf_crop_left: string;
  pdf_threshold: string;
  pdf_dither: string;
  pdf_dither_on: string;
  pdf_dither_off: string;
  pdf_dither_strength: string;
  pdf_invert: string;
  pdf_invert_on: string;
  pdf_invert_off: string;
  pdf_uploading: (percent: number) => string;
  pdf_uploading_indeterminate: string;
  pdf_options_invalid: string;
  pdf_crop_sum_invalid: string;
  pdf_err_not_pdf: string;
  pdf_err_too_large: string;
  pdf_err_encrypted: string;
  pdf_err_parse_failed: string;
  pdf_err_page_range_invalid: string;
  pdf_err_no_pages_selected: string;
  pdf_err_upload_failed: string;
  pdf_err_convert_failed: string;
  pdf_err_timeout: string;

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

  // --- 端末別ライブラリ・パスキー認証・ペアリング（実装計画 §14） ---
  save: string;
  tab_convert: string;
  tab_library: string;
  tab_devices: string;

  account_login: string;
  account_logout: string;
  account_login_prompt: string;
  account_add_passkey: string;
  account_add_passkey_intro: string;

  login_dialog_title: string;
  login_dialog_intro: string;
  login_button: string;
  login_failed: string;

  register_dialog_title: string;
  register_display_name_label: string;
  register_display_name_placeholder: string;
  register_submit: string;
  register_failed: string;
  register_logged_in_conflict: (displayName: string) => string;

  library_loading: string;
  library_load_failed: string;
  library_empty: string;
  library_download: string;
  library_item_edit: string;
  library_delete: string;
  library_delete_confirm: string;
  library_select_item: (title: string) => string;
  library_delete_selected: (n: number) => string;
  library_delete_selected_confirm: (n: number) => string;
  library_deleting: string;
  library_delete_selected_failed: (n: number) => string;
  library_selected_count: (n: number) => string;
  library_add_to_device: string;
  library_add_to_device_none: string;
  library_add_to_device_done: string;
  library_add_to_device_failed: string;
  library_author_none: string;
  library_save: string;
  library_saving: string;
  library_saved: string;
  library_saved_inline: string;
  library_saving_inline: string;
  library_save_failed: string;

  devices_load_failed: string;
  devices_empty: string;
  devices_rename: string;
  devices_edit_library: string;
  devices_rotate_token: string;
  devices_rotate_confirm: string;
  devices_revoke: string;
  devices_revoke_confirm: string;
  devices_status_active: string;
  devices_status_revoked: string;
  devices_last_seen_never: string;
  devices_token_dialog_title: string;
  devices_token_shown_once: string;
  devices_token_copy: string;
  devices_token_copied: string;
  devices_token_close: string;

  device_library_title: (name: string) => string;
  device_library_select_all: string;
  device_library_deselect_all: string;
  device_library_move_up: string;
  device_library_move_down: string;
  device_library_save: string;
  device_library_conflict: string;
  device_library_reload: string;
  device_library_empty: string;
  device_library_save_failed: string;

  pairing_dialog_title: string;
  pairing_login_required: string;
  pairing_requested_name_label: string;
  pairing_approve: string;
  pairing_reject: string;
  pairing_not_found: string;
  pairing_action_failed: string;
}

export const I18N: Record<Lang, Messages> = {
  ja: {
    brand: "XTC 変換",
    intro: "公開されているWebサイトやコンテンツを、電子ペーパー端末 Xteink X3 用の XTC ファイルに変換します。",
    convert: "変換する",
    agree_before: "「変換する」を押すことで、",
    agree_link: "利用規約",
    agree_after: "に同意したものとします。",
    history: "履歴",
    clear_all: "すべて削除",
    about_link: "このサービスについて",
    copyright_line: "© 2026 aGFydWtp",
    dl: "XTC をダウンロード",
    menu_label: "操作メニュー",
    menu_open: "メニューを開く",
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

    pdf_or_drop: "または PDF をドラッグ＆ドロップ",
    pdf_pick_file: "ファイルを選択",
    pdf_drop_active: "ここにドロップ",
    pdf_file_label: "ファイル",
    pdf_size_label: "サイズ",
    pdf_pages_label: "ページ数",
    pdf_remove_file: "ファイルを解除",
    pdf_preview_note: "プレビューは変換結果の目安です。PDFの描画方式の違いにより、実際のXTCとわずかに異なる場合があります。",
    pdf_mode_source: "元PDF",
    pdf_mode_x3: "X3プレビュー",
    pdf_page_indicator: (n, total) => `${n} / ${total}`,
    pdf_target_pages: "対象ページ",
    pdf_pages_hint: "例: 1-10, 1,3,5-8",
    pdf_rotation: "回転",
    pdf_fit: "収め方",
    pdf_fit_contain: "全体を収める",
    pdf_fit_cover: "画面を埋める",
    pdf_margin: "余白",
    pdf_advanced: "詳細設定",
    pdf_crop: "クロップ（上/右/下/左）",
    pdf_crop_top: "上",
    pdf_crop_right: "右",
    pdf_crop_bottom: "下",
    pdf_crop_left: "左",
    pdf_threshold: "二値化しきい値",
    pdf_dither: "ディザリング",
    pdf_dither_on: "あり",
    pdf_dither_off: "なし",
    pdf_dither_strength: "ディザリング強度",
    pdf_invert: "白黒反転",
    pdf_invert_on: "する",
    pdf_invert_off: "しない",
    pdf_uploading: (percent) => `アップロード中 ${percent}%`,
    pdf_uploading_indeterminate: "アップロード中…",
    pdf_options_invalid: "設定値を確認してください。",
    pdf_crop_sum_invalid: "クロップは上下・左右それぞれの合計が80%未満になるように設定してください。",
    pdf_err_not_pdf: "PDFファイルを選択してください。",
    pdf_err_too_large: "ファイルサイズが上限を超えています。",
    pdf_err_encrypted: "パスワードで保護されたPDFには対応していません。",
    pdf_err_parse_failed: "PDFを読み込めませんでした。ファイルが壊れている可能性があります。",
    pdf_err_page_range_invalid: "ページ範囲を確認してください。",
    pdf_err_no_pages_selected: "変換するページを1ページ以上選択してください。",
    pdf_err_upload_failed: "PDFのアップロードに失敗しました。",
    pdf_err_convert_failed: "XTCへの変換に失敗しました。",
    pdf_err_timeout: "PDFが大きいため、変換が時間内に完了しませんでした。",

    aozora_open: "青空文庫から選択",
    aozora_title: "青空文庫から選択",
    aozora_hint: "タイトル・作者名で検索",
    cancel: "キャンセル",
    aozora_start: "作品名か作者名を入力してください。",
    aozora_searching: "検索中…",
    aozora_empty: "該当する作品が見つかりませんでした。",
    aozora_fail: "検索に失敗しました。時間をおいてお試しください。",
    aozora_results: (n) => `検索結果 · ${n}件`,
    aozora_selected: (n, max) => `${n} / ${max} 件選択中`,
    aozora_convert: (n) => n > 0 ? `${n} 件を変換する` : "変換する",
    status: { queued: "待機中", rendering: "PDF 生成中", converting: "XTC 変換中", completed: "✓ 完了", failed: "失敗", expired: "期限切れ" },

    save: "保存する",
    tab_convert: "変換",
    tab_library: "ライブラリ",
    tab_devices: "端末",

    account_login: "ログイン",
    account_logout: "ログアウト",
    account_login_prompt: "この機能を使うにはログインしてください。",
    account_add_passkey: "パスキーを追加登録",
    account_add_passkey_intro: "この端末を新しいパスキーとして、今のアカウントに登録します。",

    login_dialog_title: "ログイン",
    login_dialog_intro: "登録済みのパスキーでログインします。",
    login_button: "パスキーでログイン",
    login_failed: "ログインに失敗しました。時間をおいてお試しください。",

    register_dialog_title: "パスキーを登録",
    register_display_name_label: "表示名",
    register_display_name_placeholder: "例：Haruki",
    register_submit: "パスキーを登録する",
    register_failed: "登録に失敗しました。招待リンクの有効期限が切れている可能性があります。",
    register_logged_in_conflict: (displayName) => `現在 ${displayName} でログイン中です。新しいアカウントを作成するには先にログアウトしてください。`,

    library_loading: "読み込み中…",
    library_load_failed: "ライブラリの取得に失敗しました。",
    library_empty: "保存されたXTCはまだありません。",
    library_download: "ダウンロード",
    library_item_edit: "編集",
    library_delete: "削除",
    library_delete_confirm: "このXTCをライブラリから削除しますか？（端末の配信リストからも外れます）",
    library_select_item: (title) => `「${title}」を選択`,
    library_delete_selected: (n) => `選択した${n}件を削除`,
    library_delete_selected_confirm: (n) => `選択した${n}件のXTCをライブラリから削除しますか？（端末の配信リストからも外れます）`,
    library_deleting: "削除中…",
    library_delete_selected_failed: (n) => `${n}件の削除に失敗しました。`,
    library_selected_count: (n) => `${n} 件選択中`,
    library_add_to_device: "端末に追加",
    library_add_to_device_none: "端末に追加（端末未登録）",
    library_add_to_device_done: "端末に追加しました。",
    library_add_to_device_failed: "端末への追加に失敗しました。",
    library_author_none: "著者（任意）",
    library_save: "ライブラリへ保存",
    library_saving: "保存中…",
    library_saved: "保存済み",
    library_saved_inline: "ライブラリ保存済み",
    library_saving_inline: "ライブラリ保存中…",
    library_save_failed: "保存に失敗しました。",

    devices_load_failed: "端末一覧の取得に失敗しました。",
    devices_empty: "ペアリング済みの端末はまだありません。",
    devices_rename: "名前を変更",
    devices_edit_library: "配信リストを編集",
    devices_rotate_token: "トークンを再発行",
    devices_rotate_confirm: "トークンを再発行しますか？古いトークンは即座に無効になります。",
    devices_revoke: "解除",
    devices_revoke_confirm: "この端末を解除しますか？以後、この端末からのアクセスはできなくなります。",
    devices_status_active: "有効",
    devices_status_revoked: "解除済み",
    devices_last_seen_never: "未接続",
    devices_token_dialog_title: "新しいトークン",
    devices_token_shown_once: "このトークンは今だけ表示されます。閉じると二度と表示できません。端末側の設定にコピーしてください。",
    devices_token_copy: "コピー",
    devices_token_copied: "コピーしました",
    devices_token_close: "閉じる",

    device_library_title: (name) => `配信リストの編集 — ${name}`,
    device_library_select_all: "すべて追加",
    device_library_deselect_all: "すべて解除",
    device_library_move_up: "上へ",
    device_library_move_down: "下へ",
    device_library_save: "保存する",
    device_library_conflict: "他の画面で更新されています。再読み込みしてください。",
    device_library_reload: "再読み込み",
    device_library_empty: "ライブラリにXTCがありません。先に変換してライブラリへ保存してください。",
    device_library_save_failed: "配信リストの保存に失敗しました。",

    pairing_dialog_title: "端末のペアリング承認",
    pairing_login_required: "ペアリングを承認するにはログインしてください。",
    pairing_requested_name_label: "端末の名前",
    pairing_approve: "承認する",
    pairing_reject: "拒否する",
    pairing_not_found: "ペアリングが見つかりません。コードの有効期限が切れている可能性があります。",
    pairing_action_failed: "操作に失敗しました。もう一度お試しください。",
  },
  en: {
    brand: "XTC Converter",
    intro: "Converts publicly available websites and content into XTC files for the Xteink X3 e-paper reader.",
    convert: "Convert",
    agree_before: "By pressing “Convert”, you agree to the ",
    agree_link: "Terms of Use",
    agree_after: ". ",
    history: "History",
    clear_all: "Clear all",
    about_link: "About this service",
    copyright_line: "© 2026 aGFydWtp",
    dl: "Download XTC",
    menu_label: "Actions",
    menu_open: "Open menu",
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

    pdf_or_drop: "or drag and drop a PDF",
    pdf_pick_file: "Choose file",
    pdf_drop_active: "Drop here",
    pdf_file_label: "File",
    pdf_size_label: "Size",
    pdf_pages_label: "Pages",
    pdf_remove_file: "Remove file",
    pdf_preview_note: "The preview is only an approximation of the conversion result. Because the browser and server render PDFs differently, the final XTC file may look slightly different.",
    pdf_mode_source: "Original PDF",
    pdf_mode_x3: "X3 preview",
    pdf_page_indicator: (n, total) => `${n} / ${total}`,
    pdf_target_pages: "Pages",
    pdf_pages_hint: "e.g. 1-10, 1,3,5-8",
    pdf_rotation: "Rotation",
    pdf_fit: "Fit",
    pdf_fit_contain: "Fit inside",
    pdf_fit_cover: "Fill screen",
    pdf_margin: "Margin",
    pdf_advanced: "Advanced settings",
    pdf_crop: "Crop (top/right/bottom/left)",
    pdf_crop_top: "Top",
    pdf_crop_right: "Right",
    pdf_crop_bottom: "Bottom",
    pdf_crop_left: "Left",
    pdf_threshold: "Threshold",
    pdf_dither: "Dithering",
    pdf_dither_on: "On",
    pdf_dither_off: "Off",
    pdf_dither_strength: "Dither strength",
    pdf_invert: "Invert colors",
    pdf_invert_on: "On",
    pdf_invert_off: "Off",
    pdf_uploading: (percent) => `Uploading ${percent}%`,
    pdf_uploading_indeterminate: "Uploading…",
    pdf_options_invalid: "Please check the conversion settings.",
    pdf_crop_sum_invalid: "Keep the top+bottom and left+right crop totals under 80%.",
    pdf_err_not_pdf: "Please select a PDF file.",
    pdf_err_too_large: "The file size exceeds the limit.",
    pdf_err_encrypted: "Password-protected PDFs are not supported.",
    pdf_err_parse_failed: "Could not read the PDF. The file may be corrupted.",
    pdf_err_page_range_invalid: "Please check the page range.",
    pdf_err_no_pages_selected: "Select at least one page to convert.",
    pdf_err_upload_failed: "Failed to upload the PDF.",
    pdf_err_convert_failed: "Failed to convert to XTC.",
    pdf_err_timeout: "The PDF is too large and the conversion did not finish in time.",

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

    save: "Save",
    tab_convert: "Convert",
    tab_library: "Library",
    tab_devices: "Devices",

    account_login: "Log in",
    account_logout: "Log out",
    account_login_prompt: "Please log in to use this feature.",
    account_add_passkey: "Register another passkey",
    account_add_passkey_intro: "Register this device as a new passkey for your current account.",

    login_dialog_title: "Log in",
    login_dialog_intro: "Log in with one of your registered passkeys.",
    login_button: "Log in with passkey",
    login_failed: "Login failed. Please try again later.",

    register_dialog_title: "Register a passkey",
    register_display_name_label: "Display name",
    register_display_name_placeholder: "e.g. Haruki",
    register_submit: "Register passkey",
    register_failed: "Registration failed. The invite link may have expired.",
    register_logged_in_conflict: (displayName) => `You're currently logged in as ${displayName}. To create a new account, please log out first.`,

    library_loading: "Loading…",
    library_load_failed: "Failed to load your library.",
    library_empty: "You haven't saved any XTC files yet.",
    library_download: "Download",
    library_item_edit: "Edit",
    library_delete: "Delete",
    library_delete_confirm: "Remove this XTC from your library? (It will also be removed from every device's list.)",
    library_select_item: (title) => `Select "${title}"`,
    library_delete_selected: (n) => `Delete ${n} selected`,
    library_delete_selected_confirm: (n) => n === 1
      ? "Remove the selected XTC from your library? (It will also be removed from every device's list.)"
      : `Remove the ${n} selected XTC files from your library? (They will also be removed from every device's list.)`,
    library_deleting: "Deleting…",
    library_delete_selected_failed: (n) => n === 1 ? "Failed to delete 1 item." : `Failed to delete ${n} items.`,
    library_selected_count: (n) => `${n} selected`,
    library_add_to_device: "Add to device",
    library_add_to_device_none: "Add to device (no devices)",
    library_add_to_device_done: "Added to the device.",
    library_add_to_device_failed: "Failed to add to the device.",
    library_author_none: "Author (optional)",
    library_save: "Save to library",
    library_saving: "Saving…",
    library_saved: "Saved",
    library_saved_inline: "Saved to library",
    library_saving_inline: "Saving to library…",
    library_save_failed: "Failed to save.",

    devices_load_failed: "Failed to load your devices.",
    devices_empty: "No paired devices yet.",
    devices_rename: "Rename",
    devices_edit_library: "Edit reading list",
    devices_rotate_token: "Rotate token",
    devices_rotate_confirm: "Rotate the token? The old token stops working immediately.",
    devices_revoke: "Unpair",
    devices_revoke_confirm: "Unpair this device? It will no longer be able to connect.",
    devices_status_active: "Active",
    devices_status_revoked: "Unpaired",
    devices_last_seen_never: "Never connected",
    devices_token_dialog_title: "New token",
    devices_token_shown_once: "This token is only shown now. Once you close this dialog it can't be shown again — copy it into your device's settings.",
    devices_token_copy: "Copy",
    devices_token_copied: "Copied",
    devices_token_close: "Close",

    device_library_title: (name) => `Edit reading list — ${name}`,
    device_library_select_all: "Add all",
    device_library_deselect_all: "Remove all",
    device_library_move_up: "Move up",
    device_library_move_down: "Move down",
    device_library_save: "Save",
    device_library_conflict: "This list was updated elsewhere. Please reload.",
    device_library_reload: "Reload",
    device_library_empty: "Your library has no XTC files yet. Convert something and save it to your library first.",
    device_library_save_failed: "Failed to save the reading list.",

    pairing_dialog_title: "Approve device pairing",
    pairing_login_required: "Please log in to approve this pairing.",
    pairing_requested_name_label: "Device name",
    pairing_approve: "Approve",
    pairing_reject: "Reject",
    pairing_not_found: "Pairing not found. The code may have expired.",
    pairing_action_failed: "The action failed. Please try again.",
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
// 写像して言語切替に追従させる。対応表は resolveServerErrorKey（server-error-text.ts）
// に切り出してあり、詳細な対応関係はそこのコメントを参照。未知のものはそのまま表示。
export function serverErrorText(err: string): string {
  const key = resolveServerErrorKey(err);
  return key ? t(key) : err;
}

// 未知のステータス値はそのまま表示する（サーバー側が先行して新ステータスを返した場合の保険）
export function statusLabel(status: string): string {
  const table = t("status");
  return Object.hasOwn(table, status) ? table[status as JobStatus] : String(status);
}
