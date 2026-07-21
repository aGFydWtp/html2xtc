// SPDX-License-Identifier: AGPL-3.0-or-later
// サーバー由来のエラー文字列 → i18n キーの対応表（実装仕様書 §9.4/§11.11/§14.2）。
//
// i18n.svelte.ts は Svelte 5 runes（$state）を使うファイルで、rune を解決する
// svelte プリプロセッサなしには import できない
// （frontend/vitest.config.ts は @sveltejs/vite-plugin-svelte を読み込んでおらず、
// 素の vitest 環境では `$state is not defined` で読み込みに失敗する）。
// この対応表だけを純粋関数として切り出しておくことで、i18n.svelte.ts 自体を
// import せずに単体テストできる（frontend/test/server-error-text.test.ts）。
//
// PDFアップロード系のエラー文字列は src/pdf-upload.ts#uploadedPdfErrorMessage が
// Container（converter/pdf_upload.py）の機械可読な `code` から決定する安定文字列。
// サイズ超過メッセージだけはバイト値を埋め込むため正規表現でマッチする。
import type { Messages } from "./i18n.svelte";

export type ServerErrorKey = keyof Pick<
  Messages,
  | "pdf_too_large"
  | "pdf_err_too_large"
  | "pdf_err_not_pdf"
  | "pdf_options_invalid"
  | "pdf_err_encrypted"
  | "pdf_err_parse_failed"
  | "pdf_err_page_range_invalid"
  | "pdf_err_no_pages_selected"
  | "pdf_err_timeout"
  | "pdf_err_convert_failed"
>;

/** サーバーのエラー文字列から対応する i18n キーを解決する。未知のものは null。 */
export function resolveServerErrorKey(err: string): ServerErrorKey | null {
  if (/rendered PDF exceeds the \d+ byte limit/.test(err)) return "pdf_too_large";
  if (/uploaded PDF exceeds the \d+ byte limit/.test(err)) return "pdf_err_too_large";
  if (err === "uploaded file is not a PDF") return "pdf_err_not_pdf";
  if (err === "invalid PDF conversion options") return "pdf_options_invalid";
  if (err === "uploaded PDF is encrypted") return "pdf_err_encrypted";
  if (err === "unable to parse uploaded PDF") return "pdf_err_parse_failed";
  if (err === "invalid page range for uploaded PDF") return "pdf_err_page_range_invalid";
  if (err === "no pages selected for uploaded PDF") return "pdf_err_no_pages_selected";
  // src/pdf-upload.ts#uploadedPdfErrorMessage の既定フォールバック（未知/未認識の
  // Container コード）。汎用文言だが「解析不能」が最も近い意味なのでそこへ寄せる。
  if (err === "invalid or unsupported PDF") return "pdf_err_parse_failed";
  if (/XTC conversion timed out; the document is too large/.test(err)) return "pdf_err_timeout";
  // URL/PDF 両ソースの Workflow が最終的に投げる汎用メッセージ（src/workflow.ts）。
  if (err === "XTC conversion failed") return "pdf_err_convert_failed";
  return null;
}
