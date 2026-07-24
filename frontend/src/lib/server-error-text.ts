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
//
// TXTアップロード系（text_err_*）: src/text-upload.ts#textPrepareErrorMessage
// （prepare-text ステップの NonRetryableError 文言）および src/workflow.ts の
// runTextSource（render-text-pdf/convert-xtc ステップの NonRetryableError 文言）
// を正として突き合わせ済み（2026-07-21 バックエンド実装確定後に確認）。
//
// 以下は意図的にマッピングしていない（実装を確認したうえでの判断）:
// - "Content-Type must be text/plain or application/octet-stream"（415）:
//   PDF側の同種メッセージ「Content-Type must be application/pdf or
//   application/x-pdf」も未マッピングであり、既存の方針と揃えた。フロントは
//   常に Content-Type: text/plain を送るため、通常到達しない。
// - "uploaded text file is missing" / "prepared article HTML is missing" /
//   "intermediate PDF is missing": R2オブジェクトが処理中に失効した場合のみ
//   発生する内部的なエラーで、PDF側の対応する文言（"uploaded PDF is missing"
//   等）も同様に未マッピング。
// - 「フォント失敗」（仕様書§19.1）: buildInlineFontCss はフォント取得に失敗
//   してもジョブを失敗させないフェイルソフト設計（src/workflow.ts の
//   runTextSource コメント参照）。ジョブの error として届くことはないため、
//   対応するサーバー文字列自体が存在しない。
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
  | "pdf_err_render_failed"
  | "pdf_err_render_timeout"
  | "text_err_empty"
  | "text_err_too_large"
  | "text_err_encoding_unknown"
  | "text_err_utf16"
  | "text_err_binary"
  | "text_err_too_many_chars"
  | "text_err_too_many_lines"
  | "text_err_line_too_long"
  | "text_err_pdf_too_large"
  | "epub_err_too_large"
  | "epub_err_invalid_zip"
  | "epub_err_missing_package"
  | "epub_err_empty_spine"
  | "epub_err_encrypted"
  | "epub_err_fixed_layout"
>;

/** サーバーのエラー文字列から対応する i18n キーを解決する。未知のものは null。 */
export function resolveServerErrorKey(err: string): ServerErrorKey | null {
  // Workflows ランタイムはエラー文言に "NonRetryableError: " のようなクラス名
  // プレフィックスを付ける。サーバー側（src/jobs.ts#stripWorkflowErrorPrefix）でも
  // 除去するが、修正前に localStorage 履歴へ保存されたジョブにはプレフィックス付き
  // 文字列が残っているため、こちらでも除去してから照合する。
  err = err.replace(/^[A-Za-z]*Error:\s+/, "");
  // TXT側の「組版後PDFが大きすぎる」（末尾 "; reduce the font size or margins"）は、
  // 接頭辞が URL/PDF側の pdf_too_large 用メッセージと共通のため、より限定的な
  // こちらを先にチェックする（src/workflow.ts#runTextSource の render-text-pdf /
  // convert-xtc ステップ）。
  if (/rendered PDF exceeds the \d+ byte limit; reduce the font size or margins/.test(err)) {
    return "text_err_pdf_too_large";
  }
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
  // URL/PDF/TXT 全ソースの Workflow が最終的に投げる汎用メッセージ（"XTC conversion
  // failed"、src/workflow.ts）。TXT専用の文言ではなく全ソース共通の文字列なので、
  // TXT専用キー（text_err_convert_failed）は作らずここへ合流させる。
  if (err === "XTC conversion failed") return "pdf_err_convert_failed";
  // render-pdf/render-text-pdf/render-epub-pdf steps (src/workflow.ts):
  // thrown when Browser Run's PDF-rendering quickAction itself fails, before
  // convert-xtc ever runs. Deliberately two entries, not one: the workflow
  // only substitutes the timeout-specific string when Browser Run's response
  // body carries error code 6002 (a Cloudflare Browser Run timeout code, per
  // its docs — HTTP 422 alone also covers OOM/page-crash causes, so 422 is
  // not a substitute signal here); every other cause keeps the generic
  // string. Previously unmapped entirely (a bug: the generic string reached
  // users untranslated even in the Japanese UI) until this pair was added.
  if (err === "PDF generation timed out; retrying may succeed") return "pdf_err_render_timeout";
  if (err === "PDF generation failed") return "pdf_err_render_failed";

  // --- TXTアップロード系（src/text-upload.ts#textPrepareErrorMessage / ------------
  //     src/workflow.ts#runTextSource と突き合わせ済みの実文字列） -----------------
  if (err === "text file is empty") return "text_err_empty";
  if (/uploaded text file exceeds the \d+ byte limit/.test(err)) return "text_err_too_large";
  if (err === "unable to determine the text encoding") return "text_err_encoding_unknown";
  if (err === "UTF-16 is not supported; convert the file to UTF-8") return "text_err_utf16";
  if (err === "uploaded file is not a plain text file") return "text_err_binary";
  // "text is too long to convert" は入力TXTの文字数超過・生成HTMLの容量超過の
  // 両方をカバーする（textPrepareErrorMessage は TextTooLongError を区別しない）。
  if (err === "text is too long to convert") return "text_err_too_many_chars";
  if (err === "line count exceeds the limit") return "text_err_too_many_lines";
  if (err === "a line exceeds the maximum line length") return "text_err_line_too_long";

  // --- EPUBアップロード系（実装仕様書 §17.1 の「クライアント向けメッセージ例」を ---
  //     正として照合。バックエンド実装（src/、別エージェント担当）が実際に投げる
  //     文字列と未突き合わせのため、一致しない場合は resolveServerErrorKey が null を
  //     返し、serverErrorText() が err をそのまま表示するフォールバックへ落ちる
  //     （壊れた表示にはならない）。
  // アップロード時の413応答（src/index.ts の Content-Length事前チェック）および
  // prepare-epubステップの防御的再検証（src/workflow.ts）が投げる、バイト数を
  // 埋め込んだ文言。「EPUB is too large to convert」（EpubErrorの構造的サイズ
  // 超過用、変換後の生成HTMLが大きすぎる場合）とは別の文言だが、ユーザー向けの
  // 意味は同じ（アップロードされたEPUBが大きすぎる）なのでPDF側（pdf_err_too_large）
  // と同様に既存の epub_err_too_large キーへ合流させる。
  if (/uploaded EPUB exceeds the \d+ byte limit/.test(err)) return "epub_err_too_large";
  if (err === "EPUB is too large to convert") return "epub_err_too_large";
  if (err === "invalid EPUB file") return "epub_err_invalid_zip";
  if (err === "EPUB package information is missing") return "epub_err_missing_package";
  if (err === "EPUB contains no readable content") return "epub_err_empty_spine";
  if (err === "encrypted EPUB is not supported") return "epub_err_encrypted";
  if (err === "fixed-layout EPUB is not supported") return "epub_err_fixed_layout";

  return null;
}
