// SPDX-License-Identifier: AGPL-3.0-or-later
// i18n。LANG_KEY は about.html（静的ページ）と共通で、言語選択が両ページ間で引き継がれる。

import { resolveServerErrorKey } from "./server-error-text";

export type Lang = "ja" | "en";

// "preparing"（本文を組版中）は TXT ジョブのみが経由するフェーズ（仕様書 §19）。
export type JobStatus = "queued" | "preparing" | "rendering" | "converting" | "completed" | "failed" | "expired";

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
  pdf_meta_line: (size: string, pages: number | null) => string;
  pdf_remove_file: string;
  pdf_preview_note: string;
  pdf_preview_label: string;
  pdf_mode_source: string;
  pdf_mode_x3: string;
  pdf_mode_compare: string;
  pdf_page_indicator: (n: number, total: number) => string;
  pdf_target_pages: string;
  pdf_page_start: string;
  pdf_page_end: string;
  pdf_rotation: string;
  pdf_fit_contain: string;
  pdf_fit_cover: string;
  pdf_margin: string;
  pdf_output_margin: string;
  pdf_advanced: string;
  pdf_advanced_note: string;
  pdf_advanced_summary: (fitLabel: string, marginPx: number, ditherLabel: string) => string;
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

  // --- TXTアップロード入力（実装仕様書 §6, §10, §19） -----------------------------
  text_remove_file: string;
  text_meta_line: (size: string, chars: number, lines: number) => string;
  text_tab_body: string;
  text_tab_x3: string;
  text_encoding_label: string;
  text_encoding_option_auto: string;
  text_encoding_option_utf8: string;
  text_encoding_option_shift_jis: string;
  text_encoding_detected: (label: string) => string;
  text_presets_label: string;
  text_preset_standard: string;
  text_preset_vertical_novel: string;
  text_preset_large_font: string;
  text_options_heading: string;
  text_options_summary: (layoutLabel: string, fontSizePx: number) => string;

  // --- 入力形式（青空文庫TXT変換 実装仕様書 §15.1） -----------------------------
  text_input_format_label: string;
  text_input_format_plain: string;
  text_input_format_aozora: string;
  text_input_format_plain_hint: string;
  text_input_format_aozora_hint: string;

  text_layout_label: string;
  text_layout_horizontal: string;
  text_layout_vertical: string;
  text_font_label: string;
  text_font_size_label: string;
  text_line_height_label: string;
  text_paragraph_spacing_label: string;
  text_margin_label: string;
  text_margin_top: string;
  text_margin_right: string;
  text_margin_bottom: string;
  text_margin_left: string;
  text_align_label: string;
  text_align_start: string;
  text_align_justify: string;
  text_max_blank_lines_label: string;
  text_preserve_spaces_label: string;
  text_preserve_spaces_on: string;
  text_preserve_spaces_off: string;
  text_join_lines_label: string;
  text_join_lines_on: string;
  text_join_lines_off: string;
  text_join_lines_note: string;
  text_join_lines_aozora_note: string;
  text_bibliographic_heading: string;
  text_title_label: string;
  text_author_label: string;
  text_uploading: (percent: number) => string;
  text_uploading_indeterminate: string;
  text_options_invalid: string;
  text_err_not_txt: string;
  text_err_empty: string;
  text_err_too_large: string;
  text_err_encoding_unknown: string;
  text_err_utf16: string;
  text_err_binary: string;
  text_err_too_many_chars: string;
  text_err_too_many_lines: string;
  text_err_line_too_long: string;
  text_err_font_fallback: string;
  text_err_pdf_too_large: string;
  text_err_upload_failed: string;

  // --- X3実機(XTC)プレビュー（POST /preview/text、実装仕様書 §18） -----------------
  text_x3_preview_regenerate_button: string;
  text_x3_preview_generating: string;
  text_x3_page_indicator: (n: number, total: number) => string;
  text_x3_preview_note: string;
  text_x3_preview_stale_note: string;
  text_x3_preview_rate_limited: string;
  text_x3_preview_timeout: string;
  text_x3_preview_too_long: string;
  text_x3_preview_empty: string;
  text_x3_preview_failed: string;

  // --- 青空文庫本文プレビュー・診断件数（実装仕様書 §15.5） ---------------------------
  text_aozora_parsed_note: string;
  text_aozora_unsupported_note: (n: number) => string;
  text_aozora_diagnostics_truncated_note: string;

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
  tab_flasher: string;

  // --- CrossPoint JP ファームウェア更新（実装仕様書 §13） ---------------------
  flasher_title: string;
  flasher_intro: string;
  flasher_channel_heading: string;
  flasher_dev: string;
  flasher_dev_description: string;
  flasher_stable: string;
  flasher_stable_description: string;
  flasher_version: (version: string) => string;
  flasher_loading: string;
  flasher_not_released: string;
  flasher_manifest_failed: string;
  flasher_manifest_invalid: string;
  flasher_install: string;
  flasher_unsupported: string;
  flasher_https_required: string;
  flasher_instructions_heading: string;
  flasher_instruction_connect: string;
  flasher_instruction_select: string;
  flasher_instruction_install: string;
  flasher_instruction_port: string;
  flasher_instruction_wait: string;
  flasher_warning_heading: string;
  flasher_warning_browser: string;
  flasher_warning_erase: string;
  flasher_warning_disconnect: string;
  flasher_warning_restart: string;

  account_login: string;
  account_logout: string;
  account_login_prompt: string;
  account_add_passkey: string;
  account_add_passkey_intro: string;
  account_menu_item: string;
  account_register_open: string;

  // --- アカウント画面（登録モード仕様 Phase1 §5.9） ---------------------------
  account_dialog_title: string;
  account_section_usage: string;
  account_section_passkeys: string;
  account_section_sessions: string;
  account_section_devices: string;
  account_section_danger: string;

  account_usage_loading: string;
  account_usage_load_failed: string;
  account_usage_library_items: string;
  account_usage_library_bytes: string;
  account_usage_devices: string;
  account_usage_sessions: string;
  account_usage_passkeys: string;
  account_usage_count: (used: number, limit: number) => string;
  account_usage_bytes: (used: string, limit: string) => string;
  account_usage_warning: string;
  account_usage_full: string;

  account_passkeys_loading: string;
  account_passkeys_load_failed: string;
  account_passkey_created: (date: string) => string;
  account_passkey_last_used: (date: string) => string;
  account_passkey_last_used_never: string;
  account_passkey_synced: string;
  account_passkey_delete: string;
  account_passkey_delete_confirm: string;
  account_passkey_delete_failed: string;
  account_passkey_last_passkey: string;
  account_passkey_last_passkey_title: string;

  account_sessions_loading: string;
  account_session_current: string;
  account_session_revoke: string;
  account_session_revoke_confirm: string;

  account_delete_intro: string;
  account_delete_input_label: string;
  account_delete_input_placeholder: string;
  account_delete_button: string;
  account_delete_failed: string;

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

  // --- 登録停止案内（登録モード仕様 Phase3 §5） -------------------------------
  register_closed_title: string;
  register_closed_body: string;
  register_closed_login: string;
  register_closed_close: string;

  // --- 公開登録（登録モード仕様 Phase2 §5.2 (4)(5)(6)） -----------------------
  register_open_dialog_title: string;
  register_open_warning: string;
  register_terms_agree_before: string;
  register_terms_link: string;
  register_terms_agree_after: string;
  register_privacy_agree_before: string;
  register_privacy_link: string;
  register_privacy_agree_after: string;
  register_turnstile_unavailable: string;
  register_open_failed: string;
  register_error_capacity_reached: string;
  register_error_verification_unavailable: string;
  register_error_invalid_turnstile: string;
  register_error_terms_mismatch: string;
  register_done_message: string;
  register_done_add_passkey: string;
  register_done_later: string;

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
  devices_empty_hint: string;
  devices_empty_flash: string;
  devices_rename: string;
  devices_edit_library: string;
  devices_revoke: string;
  devices_revoke_confirm: string;
  devices_last_seen_never: string;
  devices_howto_btn: string;
  devices_howto_title: string;
  devices_howto_step1_heading: string;
  devices_howto_step1_device: string;
  devices_howto_step1_firmware: string;
  devices_howto_step1_connect: string;
  devices_howto_step1_flasher: string;
  devices_howto_step2_heading: string;
  devices_howto_step2_menu: string;
  devices_howto_step2_qr: string;
  devices_howto_step2_scan: string;
  devices_howto_step2_login: string;
  devices_howto_step2_approve: string;
  devices_howto_step2_expiry: string;

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

    pdf_or_drop: "または PDF / TXT をここにドラッグ＆ドロップ ／ ",
    pdf_pick_file: "ファイルを選択",
    pdf_drop_active: "ここにドロップ",
    pdf_file_label: "ファイル",
    pdf_size_label: "サイズ",
    pdf_pages_label: "ページ数",
    pdf_meta_line: (size, pages) => (pages ? `${size} ・ ${pages} ページ` : size),
    pdf_remove_file: "ファイルを解除",
    pdf_preview_note: "プレビューは変換結果の目安です。PDFの描画方式の違いにより、実際のXTCとわずかに異なる場合があります。",
    pdf_preview_label: "表示プレビュー",
    pdf_mode_source: "元PDF",
    pdf_mode_x3: "X3プレビュー",
    pdf_mode_compare: "比較",
    pdf_page_indicator: (n, total) => `${n} / ${total}`,
    pdf_target_pages: "ページ範囲",
    pdf_page_start: "開始",
    pdf_page_end: "終了",
    pdf_rotation: "回転",
    pdf_fit_contain: "全体を収める",
    pdf_fit_cover: "横幅に合わせる",
    pdf_margin: "余白",
    pdf_output_margin: "出力余白",
    pdf_advanced: "詳細設定",
    pdf_advanced_note: "PDF はページレイアウトが確定しているため、フォント・文字サイズ・組方向・行間は変更できません。",
    pdf_advanced_summary: (fitLabel, marginPx, ditherLabel) => `${fitLabel} ・ 余白${marginPx}px ・ ディザ${ditherLabel}`,
    pdf_crop: "クロップ（%）",
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

    text_remove_file: "ファイルを解除",
    text_meta_line: (size, chars, lines) => `${size} ・ ${chars.toLocaleString("ja-JP")}字 ・ ${lines.toLocaleString("ja-JP")}行`,
    text_tab_body: "本文",
    text_tab_x3: "X3プレビュー",
    text_encoding_label: "文字コード",
    text_encoding_option_auto: "自動判定",
    text_encoding_option_utf8: "UTF-8",
    text_encoding_option_shift_jis: "Shift_JIS（Windows-31J）",
    text_encoding_detected: (label) => `自動判定: ${label}`,
    text_presets_label: "プリセット",
    text_preset_standard: "標準",
    text_preset_vertical_novel: "小説・縦書き",
    text_preset_large_font: "大きな文字",
    text_options_heading: "詳細設定",
    text_options_summary: (layoutLabel, fontSizePx) => `${layoutLabel} ・ ${fontSizePx}px`,
    text_input_format_label: "入力形式",
    text_input_format_plain: "プレーンテキスト",
    text_input_format_aozora: "青空文庫形式",
    text_input_format_plain_hint: "注記や記法を解釈せず、そのまま表示します",
    text_input_format_aozora_hint: "ルビ、傍点、見出し、改ページなどを解釈します",
    text_layout_label: "書字方向",
    text_layout_horizontal: "横書き",
    text_layout_vertical: "縦書き",
    text_font_label: "フォント",
    text_font_size_label: "フォントサイズ",
    text_line_height_label: "行間",
    text_paragraph_spacing_label: "段落間隔",
    text_margin_label: "余白",
    text_margin_top: "上",
    text_margin_right: "右",
    text_margin_bottom: "下",
    text_margin_left: "左",
    text_align_label: "文字揃え",
    text_align_start: "行頭揃え",
    text_align_justify: "両端揃え",
    text_max_blank_lines_label: "空行上限",
    text_preserve_spaces_label: "空白保持",
    text_preserve_spaces_on: "保持する",
    text_preserve_spaces_off: "保持しない",
    text_join_lines_label: "行を自動的につなげる",
    text_join_lines_on: "つなげる",
    text_join_lines_off: "つなげない",
    text_join_lines_note: "固定幅で改行されたテキストの行を段落内で連結します。",
    text_join_lines_aozora_note: "青空文庫形式では、注記や組版上の改行を保護するため使用できません。",
    text_bibliographic_heading: "書誌情報",
    text_title_label: "表題",
    text_author_label: "著者",
    text_uploading: (percent) => `アップロード中 ${percent}%`,
    text_uploading_indeterminate: "アップロード中…",
    text_options_invalid: "設定値を確認してください。",
    text_err_not_txt: "テキストファイルを選択してください。",
    text_err_empty: "空のテキストファイルは変換できません。",
    text_err_too_large: "テキストファイルのサイズが上限を超えています。",
    text_err_encoding_unknown: "文字コードを判定できませんでした。",
    text_err_utf16: "UTF-16形式には対応していません。UTF-8へ変換してください。",
    text_err_binary: "このファイルはプレーンテキストとして読み込めません。",
    text_err_too_many_chars: "本文が長すぎるため変換できません。",
    text_err_too_many_lines: "行数が上限を超えています。",
    text_err_line_too_long: "1行が長すぎるため変換できません。",
    text_err_font_fallback: "指定フォントを取得できなかったため、代替フォントで変換します。",
    text_err_pdf_too_large: "組版後のPDFが大きすぎます。文字サイズや余白を調整してください。",
    text_err_upload_failed: "テキストファイルのアップロードに失敗しました。",

    text_x3_preview_regenerate_button: "X3実機プレビューを再生成",
    text_x3_preview_generating: "実機プレビューを生成しています…",
    text_x3_page_indicator: (n, total) => `${n} / ${total}`,
    text_x3_preview_note: "本文先頭部分のみを変換しています。",
    text_x3_preview_stale_note: "設定が変わっています。「再生成」で最新の実機プレビューに更新できます。",
    text_x3_preview_rate_limited: "リクエストが多すぎます。しばらくしてから再試行してください。",
    text_x3_preview_timeout: "実機プレビューの生成がタイムアウトしました。",
    text_x3_preview_too_long: "プレビュー対象の本文が長すぎます。",
    text_x3_preview_empty: "本文が空のためプレビューを生成できません。",
    text_x3_preview_failed: "実機プレビューの生成に失敗しました。",

    text_aozora_parsed_note: "青空文庫形式として解析しました。",
    text_aozora_unsupported_note: (n) => `未対応の注記 ${n}件は、注記文字として残ります。`,
    text_aozora_diagnostics_truncated_note: "診断の件数が上限に達したため、これ以降の警告は集計されていません。",

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
    status: { queued: "待機中", preparing: "本文を組版中", rendering: "PDF 生成中", converting: "XTC 変換中", completed: "✓ 完了", failed: "失敗", expired: "期限切れ" },

    save: "保存する",
    tab_convert: "変換",
    tab_library: "ライブラリ",
    tab_devices: "端末",
    tab_flasher: "ファームウェア",

    flasher_title: "CrossPoint JP",
    flasher_intro: "ブラウザからXteink X3へファームウェアをインストールできます。",
    flasher_channel_heading: "ファームウェアの選択",
    flasher_dev: "開発版",
    flasher_dev_description: "最新の変更を含む開発ビルドです。",
    flasher_stable: "安定版",
    flasher_stable_description: "テスト済みの安定リリースです。",
    flasher_version: (version) => `バージョン: ${version}`,
    flasher_loading: "バージョンを確認しています…",
    flasher_not_released: "まだリリースされていません。",
    flasher_manifest_failed: "ファームウェア情報を取得できませんでした。",
    flasher_manifest_invalid: "ファームウェア情報の形式が正しくありません。",
    flasher_install: "Xteinkへインストール",
    flasher_unsupported: "Web Serial APIに対応したChromeまたはEdgeをご利用ください。",
    flasher_https_required: "ファームウェアの書き込みにはHTTPS接続が必要です。",
    flasher_instructions_heading: "使い方",
    flasher_instruction_connect: "Xteink X3をUSB-Cケーブルでパソコンに接続します。",
    flasher_instruction_select: "開発版または安定版を選択します。",
    flasher_instruction_install: "「Xteinkへインストール」を押します。",
    flasher_instruction_port: "シリアルポート選択画面でXteinkを選択します。",
    flasher_instruction_wait: "完了するまでケーブルを抜かずに待ちます。",
    flasher_warning_heading: "注意事項",
    flasher_warning_browser: "ChromeまたはEdgeを使用してください。",
    flasher_warning_erase: "初回書き込みでは既存データが消去される可能性があります。",
    flasher_warning_disconnect: "書き込み中はUSBケーブルを抜かないでください。",
    flasher_warning_restart: "書き込み後、端末は自動的に再起動します。",

    account_login: "ログイン",
    account_logout: "ログアウト",
    account_login_prompt: "この機能を使うにはログインしてください。",
    account_add_passkey: "パスキーを追加登録",
    account_add_passkey_intro: "この端末を新しいパスキーとして、今のアカウントに登録します。",
    account_menu_item: "アカウント",
    account_register_open: "新規登録",

    account_dialog_title: "アカウント",
    account_section_usage: "使用量",
    account_section_passkeys: "パスキー",
    account_section_sessions: "セッション",
    account_section_devices: "端末",
    account_section_danger: "アカウント削除",

    account_usage_loading: "読み込み中…",
    account_usage_load_failed: "使用量の取得に失敗しました。",
    account_usage_library_items: "保存件数",
    account_usage_library_bytes: "保存容量",
    account_usage_devices: "端末登録数",
    account_usage_sessions: "アクティブセッション数",
    account_usage_passkeys: "パスキー登録数",
    account_usage_count: (used, limit) => `${used} / ${limit}`,
    account_usage_bytes: (used, limit) => `${used} / ${limit}`,
    account_usage_warning: "上限に近づいています。",
    account_usage_full: "上限に達しています。これ以上保存できません。",

    account_passkeys_loading: "読み込み中…",
    account_passkeys_load_failed: "パスキー一覧の取得に失敗しました。",
    account_passkey_created: (date) => `登録日: ${date}`,
    account_passkey_last_used: (date) => `最終使用: ${date}`,
    account_passkey_last_used_never: "最終使用: なし",
    account_passkey_synced: "クラウド同期済み",
    account_passkey_delete: "削除",
    account_passkey_delete_confirm: "このパスキーを削除しますか？以後、この端末ではログインできなくなります。",
    account_passkey_delete_failed: "パスキーの削除に失敗しました。",
    account_passkey_last_passkey: "このアカウントにはパスキーが1つだけ登録されています。端末の紛失や初期化に備えて、別の端末にも追加してください。",
    account_passkey_last_passkey_title: "最後の1本は削除できません",

    account_sessions_loading: "読み込み中…",
    account_session_current: "この端末（現在のセッション）",
    account_session_revoke: "ログアウト",
    account_session_revoke_confirm: "このセッションをログアウトさせますか？",

    account_delete_intro: "アカウントを完全に削除します。ライブラリ、端末登録、パスキー、セッションなど、すべてのデータが失われ、元に戻せません。",
    account_delete_input_label: "続行するには、下の欄に「DELETE」と入力してください。",
    account_delete_input_placeholder: "DELETE",
    account_delete_button: "アカウントを削除",
    account_delete_failed: "アカウントの削除に失敗しました。しばらくしてから再試行してください。",

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

    register_closed_title: "新規登録は停止中です",
    register_closed_body: "新規登録は現在停止しています。すでにアカウントをお持ちの場合はログインできます。",
    register_closed_login: "ログイン",
    register_closed_close: "閉じる",

    register_open_dialog_title: "新規登録",
    register_open_warning: "このサービスはパスキーのみでログインします。すべてのパスキーを失うとアカウントを復旧できません。登録後、別の端末にもパスキーを追加してください。",
    register_terms_agree_before: "",
    register_terms_link: "利用規約",
    register_terms_agree_after: "に同意する",
    register_privacy_agree_before: "",
    register_privacy_link: "プライバシーポリシー",
    register_privacy_agree_after: "を確認した",
    register_turnstile_unavailable: "認証ウィジェットを読み込めませんでした。しばらくしてから再読み込みしてください。",
    register_open_failed: "登録に失敗しました。しばらくしてから再試行してください。",
    register_error_capacity_reached: "現在、新規登録の受付上限に達しています。しばらくしてから再試行してください。",
    register_error_verification_unavailable: "現在、登録の確認処理を利用できません。しばらくしてから再試行してください。",
    register_error_invalid_turnstile: "認証に失敗しました。チェックをやり直してください。",
    register_error_terms_mismatch: "利用規約が更新されました。ページを再読み込みしてから、もう一度お試しください。",
    register_done_message: "登録が完了しました。別の端末にもバックアップ用パスキーを追加することをおすすめします。",
    register_done_add_passkey: "パスキーを追加",
    register_done_later: "あとで",

    library_loading: "読み込み中…",
    library_load_failed: "ライブラリの取得に失敗しました。",
    library_empty: "保存されたXTCファイルはまだありません。",
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
    devices_empty_hint: "端末をペアリングするには、専用ファームウェア（CrossPoint JP）のインストールが必要です。",
    devices_empty_flash: "ファームウェアをインストール",
    devices_rename: "名前を変更",
    devices_edit_library: "配信リストを編集",
    devices_revoke: "解除",
    devices_revoke_confirm: "この端末を解除しますか？以後、この端末からのアクセスはできなくなります。",
    devices_last_seen_never: "未接続",
    devices_howto_btn: "端末の追加方法",
    devices_howto_title: "端末の登録方法",
    devices_howto_step1_heading: "ステップ1: ファームウェアのインストール",
    devices_howto_step1_device: "対応端末は Xteink X3 です。",
    devices_howto_step1_firmware: "専用ファームウェア「CrossPoint JP」をインストールする必要があります。CrossPoint JP は、端末をこの「XTC 変換」アプリに接続する機能を追加したファームウェアです。",
    devices_howto_step1_connect: "Xteink X3 はポゴピン接続です。詳しい接続手順は「ファームウェア」タブの案内をご覧ください。",
    devices_howto_step1_flasher: "「ファームウェア」タブを開き、画面の手順に従ってインストールします。",
    devices_howto_step2_heading: "ステップ2: アカウントとのペアリング",
    devices_howto_step2_menu: "インストール後、端末のトップ画面に「マイXTC」というメニューが追加されます。",
    devices_howto_step2_qr: "「マイXTC」を開くと、QR コードとユーザーコードが表示されます。",
    devices_howto_step2_scan: "パソコンやスマートフォンでその QR コードを読み取るか、表示された URL を開くと、ペアリング承認ダイアログが開きます。",
    devices_howto_step2_login: "ログインしていない場合は、パスキーでログインします。",
    devices_howto_step2_approve: "端末の名前を入力して「承認する」を押すと、端末が一覧に追加されます。",
    devices_howto_step2_expiry: "ペアリングの有効期限は発行から10分です。期限切れの場合は端末側でやり直してください。",

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

    pdf_or_drop: "or drag & drop a PDF or TXT file here / ",
    pdf_pick_file: "Choose file",
    pdf_drop_active: "Drop here",
    pdf_file_label: "File",
    pdf_size_label: "Size",
    pdf_pages_label: "Pages",
    pdf_meta_line: (size, pages) => (pages ? `${size} · ${pages} pages` : size),
    pdf_remove_file: "Remove file",
    pdf_preview_note: "The preview is only an approximation of the conversion result. Because the browser and server render PDFs differently, the final XTC file may look slightly different.",
    pdf_preview_label: "Preview",
    pdf_mode_source: "Original PDF",
    pdf_mode_x3: "X3 preview",
    pdf_mode_compare: "Compare",
    pdf_page_indicator: (n, total) => `${n} / ${total}`,
    pdf_target_pages: "Pages",
    pdf_page_start: "Start",
    pdf_page_end: "End",
    pdf_rotation: "Rotation",
    pdf_fit_contain: "Fit inside",
    pdf_fit_cover: "Fit to width",
    pdf_margin: "Margin",
    pdf_output_margin: "Output margin",
    pdf_advanced: "Advanced settings",
    pdf_advanced_note: "PDF page layout is fixed, so font, text size, direction and line spacing cannot be changed.",
    pdf_advanced_summary: (fitLabel, marginPx, ditherLabel) => `${fitLabel} · Margin ${marginPx}px · Dither ${ditherLabel}`,
    pdf_crop: "Crop (%)",
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

    text_remove_file: "Remove file",
    text_meta_line: (size, chars, lines) => `${size} · ${chars.toLocaleString("en-US")} chars · ${lines.toLocaleString("en-US")} lines`,
    text_tab_body: "Text",
    text_tab_x3: "X3 preview",
    text_encoding_label: "Encoding",
    text_encoding_option_auto: "Auto-detect",
    text_encoding_option_utf8: "UTF-8",
    text_encoding_option_shift_jis: "Shift_JIS (Windows-31J)",
    text_encoding_detected: (label) => `Auto-detected: ${label}`,
    text_presets_label: "Presets",
    text_preset_standard: "Standard",
    text_preset_vertical_novel: "Novel (vertical)",
    text_preset_large_font: "Large text",
    text_options_heading: "Advanced settings",
    text_options_summary: (layoutLabel, fontSizePx) => `${layoutLabel} · ${fontSizePx}px`,
    text_input_format_label: "Input format",
    text_input_format_plain: "Plain text",
    text_input_format_aozora: "Aozora Bunko format",
    text_input_format_plain_hint: "Displays the text as-is, without interpreting any notation or markup.",
    text_input_format_aozora_hint: "Interprets ruby, emphasis dots, headings, page breaks, and more.",
    text_layout_label: "Writing direction",
    text_layout_horizontal: "Horizontal",
    text_layout_vertical: "Vertical",
    text_font_label: "Font",
    text_font_size_label: "Font size",
    text_line_height_label: "Line height",
    text_paragraph_spacing_label: "Paragraph spacing",
    text_margin_label: "Margins",
    text_margin_top: "Top",
    text_margin_right: "Right",
    text_margin_bottom: "Bottom",
    text_margin_left: "Left",
    text_align_label: "Text alignment",
    text_align_start: "Start-aligned",
    text_align_justify: "Justified",
    text_max_blank_lines_label: "Max blank lines",
    text_preserve_spaces_label: "Preserve whitespace",
    text_preserve_spaces_on: "On",
    text_preserve_spaces_off: "Off",
    text_join_lines_label: "Auto-join hard-wrapped lines",
    text_join_lines_on: "On",
    text_join_lines_off: "Off",
    text_join_lines_note: "Joins lines within a paragraph that were hard-wrapped to a fixed width.",
    text_join_lines_aozora_note: "Not available in Aozora Bunko format — line breaks from notation and typesetting must be preserved.",
    text_bibliographic_heading: "Bibliographic info",
    text_title_label: "Title",
    text_author_label: "Author",
    text_uploading: (percent) => `Uploading ${percent}%`,
    text_uploading_indeterminate: "Uploading…",
    text_options_invalid: "Please check the conversion settings.",
    text_err_not_txt: "Please select a text file.",
    text_err_empty: "An empty text file cannot be converted.",
    text_err_too_large: "The text file size exceeds the limit.",
    text_err_encoding_unknown: "Could not detect the text encoding.",
    text_err_utf16: "UTF-16 is not supported. Please convert the file to UTF-8.",
    text_err_binary: "This file could not be read as plain text.",
    text_err_too_many_chars: "The text is too long to convert.",
    text_err_too_many_lines: "The number of lines exceeds the limit.",
    text_err_line_too_long: "A line is too long to convert.",
    text_err_font_fallback: "The selected font could not be retrieved; converting with a fallback font instead.",
    text_err_pdf_too_large: "The typeset PDF is too large. Try adjusting the font size or margins.",
    text_err_upload_failed: "Failed to upload the text file.",

    text_x3_preview_regenerate_button: "Regenerate X3 device preview",
    text_x3_preview_generating: "Generating the device preview…",
    text_x3_page_indicator: (n, total) => `${n} / ${total}`,
    text_x3_preview_note: "Only the beginning of the text is converted for this preview.",
    text_x3_preview_stale_note: "Settings have changed. Use \"Regenerate\" to update the device preview.",
    text_x3_preview_rate_limited: "Too many requests. Please try again later.",
    text_x3_preview_timeout: "Generating the device preview timed out.",
    text_x3_preview_too_long: "The preview text is too long.",
    text_x3_preview_empty: "The text is empty, so no preview can be generated.",
    text_x3_preview_failed: "Failed to generate the device preview.",

    text_aozora_parsed_note: "Parsed as Aozora Bunko format.",
    text_aozora_unsupported_note: (n) => (n === 1 ? "1 unsupported annotation remains as literal annotation text." : `${n} unsupported annotations remain as literal annotation text.`),
    text_aozora_diagnostics_truncated_note: "The diagnostic count reached its limit, so further warnings were not tallied.",

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
    status: { queued: "Queued", preparing: "Preparing text", rendering: "Rendering PDF", converting: "Converting to XTC", completed: "✓ Done", failed: "Failed", expired: "Expired" },

    save: "Save",
    tab_convert: "Convert",
    tab_library: "Library",
    tab_devices: "Devices",
    tab_flasher: "Firmware",

    flasher_title: "CrossPoint JP",
    flasher_intro: "Install firmware on an Xteink X3 directly from your browser.",
    flasher_channel_heading: "Choose firmware",
    flasher_dev: "Development",
    flasher_dev_description: "The latest development build with recent changes.",
    flasher_stable: "Stable",
    flasher_stable_description: "A tested stable release.",
    flasher_version: (version) => `Version: ${version}`,
    flasher_loading: "Checking the firmware version…",
    flasher_not_released: "No release is available yet.",
    flasher_manifest_failed: "Could not load firmware information.",
    flasher_manifest_invalid: "The firmware information is invalid.",
    flasher_install: "Install on Xteink",
    flasher_unsupported: "Use a version of Chrome or Edge that supports the Web Serial API.",
    flasher_https_required: "Firmware installation requires a secure HTTPS connection.",
    flasher_instructions_heading: "Instructions",
    flasher_instruction_connect: "Connect the Xteink X3 to your computer with a USB-C cable.",
    flasher_instruction_select: "Choose the development or stable firmware.",
    flasher_instruction_install: "Select “Install on Xteink”.",
    flasher_instruction_port: "Choose the Xteink device in the serial port dialog.",
    flasher_instruction_wait: "Keep the cable connected until installation completes.",
    flasher_warning_heading: "Important",
    flasher_warning_browser: "Use Chrome or Edge.",
    flasher_warning_erase: "The first installation may erase existing data.",
    flasher_warning_disconnect: "Do not disconnect the USB cable during installation.",
    flasher_warning_restart: "The device restarts automatically after installation.",

    account_login: "Log in",
    account_logout: "Log out",
    account_login_prompt: "Please log in to use this feature.",
    account_add_passkey: "Register another passkey",
    account_add_passkey_intro: "Register this device as a new passkey for your current account.",
    account_menu_item: "Account",
    account_register_open: "Sign up",

    account_dialog_title: "Account",
    account_section_usage: "Usage",
    account_section_passkeys: "Passkeys",
    account_section_sessions: "Sessions",
    account_section_devices: "Devices",
    account_section_danger: "Delete account",

    account_usage_loading: "Loading…",
    account_usage_load_failed: "Failed to load usage.",
    account_usage_library_items: "Saved items",
    account_usage_library_bytes: "Storage used",
    account_usage_devices: "Registered devices",
    account_usage_sessions: "Active sessions",
    account_usage_passkeys: "Registered passkeys",
    account_usage_count: (used, limit) => `${used} / ${limit}`,
    account_usage_bytes: (used, limit) => `${used} / ${limit}`,
    account_usage_warning: "Approaching the limit.",
    account_usage_full: "Limit reached. Nothing more can be saved.",

    account_passkeys_loading: "Loading…",
    account_passkeys_load_failed: "Failed to load your passkeys.",
    account_passkey_created: (date) => `Registered: ${date}`,
    account_passkey_last_used: (date) => `Last used: ${date}`,
    account_passkey_last_used_never: "Last used: never",
    account_passkey_synced: "Synced to cloud",
    account_passkey_delete: "Delete",
    account_passkey_delete_confirm: "Delete this passkey? You won't be able to sign in from that device anymore.",
    account_passkey_delete_failed: "Failed to delete the passkey.",
    account_passkey_last_passkey: "This account has only one passkey registered. Add one on another device in case you lose or reset this one.",
    account_passkey_last_passkey_title: "You can't delete your only passkey",

    account_sessions_loading: "Loading…",
    account_session_current: "This device (current session)",
    account_session_revoke: "Log out",
    account_session_revoke_confirm: "Log out this session?",

    account_delete_intro: "This permanently deletes your account. Your library, devices, passkeys, and sessions will all be lost and cannot be recovered.",
    account_delete_input_label: "Type \"DELETE\" below to continue.",
    account_delete_input_placeholder: "DELETE",
    account_delete_button: "Delete account",
    account_delete_failed: "Failed to delete the account. Please try again later.",

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

    register_closed_title: "New registration is paused",
    register_closed_body: "New registration is currently paused. If you already have an account, you can still log in.",
    register_closed_login: "Log in",
    register_closed_close: "Close",

    register_open_dialog_title: "Sign up",
    register_open_warning: "This service signs you in with passkeys only. If you lose every passkey, your account cannot be recovered. After signing up, please add a passkey on another device too.",
    register_terms_agree_before: "I agree to the ",
    register_terms_link: "Terms of Use",
    register_terms_agree_after: "",
    register_privacy_agree_before: "I have reviewed the ",
    register_privacy_link: "Privacy Policy",
    register_privacy_agree_after: "",
    register_turnstile_unavailable: "Could not load the verification widget. Please reload and try again later.",
    register_open_failed: "Registration failed. Please try again later.",
    register_error_capacity_reached: "New registrations are temporarily full. Please try again later.",
    register_error_verification_unavailable: "Registration verification is currently unavailable. Please try again later.",
    register_error_invalid_turnstile: "Verification failed. Please retry the check.",
    register_error_terms_mismatch: "The terms of use have been updated. Please reload the page and try again.",
    register_done_message: "Registration complete. We recommend adding a backup passkey on another device.",
    register_done_add_passkey: "Add a passkey",
    register_done_later: "Later",

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
    devices_empty_hint: "Pairing a device requires installing the dedicated CrossPoint JP firmware first.",
    devices_empty_flash: "Install firmware",
    devices_rename: "Rename",
    devices_edit_library: "Edit reading list",
    devices_revoke: "Unpair",
    devices_revoke_confirm: "Unpair this device? It will no longer be able to connect.",
    devices_last_seen_never: "Never connected",
    devices_howto_btn: "How to add a device",
    devices_howto_title: "How to register a device",
    devices_howto_step1_heading: "Step 1: Install the firmware",
    devices_howto_step1_device: "The supported device is the Xteink X3.",
    devices_howto_step1_firmware: "It needs the dedicated CrossPoint JP firmware installed. CrossPoint JP adds the ability to connect the device to this XTC Converter app.",
    devices_howto_step1_connect: "The Xteink X3 connects via pogo pins. See the Firmware tab for detailed connection steps.",
    devices_howto_step1_flasher: "Open the Firmware tab and follow the on-screen instructions to install it.",
    devices_howto_step2_heading: "Step 2: Pair it with your account",
    devices_howto_step2_menu: "After installation, a “マイXTC” (My XTC) menu appears on the device's home screen.",
    devices_howto_step2_qr: "Open “マイXTC” to see a QR code and a user code.",
    devices_howto_step2_scan: "Scan the QR code with your computer or phone (or open the URL it shows) to open the pairing approval dialog.",
    devices_howto_step2_login: "Log in with your passkey if you aren't already.",
    devices_howto_step2_approve: "Enter a name for the device and press “Approve” to add it to your list.",
    devices_howto_step2_expiry: "The pairing code expires 10 minutes after it's issued. If it expires, start again on the device.",

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
