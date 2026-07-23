// SPDX-License-Identifier: AGPL-3.0-or-later
// ConvertForm.svelte のファイル種別判定（実装仕様書 §16.2）を切り出した純粋関数。
// このプロジェクトはSvelteコンポーネントテストの基盤を持たない（vitest.config.ts に
// @sveltejs/vite-plugin-svelte 未設定）ため、テスト可能なロジックとして .ts へ
// 切り出し、コンポーネント側からはこれを呼ぶだけにする。

export type InputFileKind = "pdf" | "text" | "epub";

// 優先順位（実装仕様書 §16.2）:
//   1. .epub 拡張子
//   2. .pdf 拡張子
//   3. .txt 拡張子
//   4. MIME
//   5. 不明なら null（呼び出し側でエラー表示）
// 拡張子チェックを最優先することで、EPUB（.epub拡張子だが MIME が空文字や
// application/octet-stream であることが多い）を TXT や不明種別と誤判定しない
// （仕様書 §16.2「EPUB を TXT と誤判定しないこと」）。
export function detectInputFileKind(file: File): InputFileKind | null {
  if (/\.epub$/i.test(file.name)) return "epub";
  if (/\.pdf$/i.test(file.name)) return "pdf";
  if (/\.txt$/i.test(file.name)) return "text";
  if (file.type === "application/epub+zip") return "epub";
  if (file.type === "application/pdf" || file.type === "application/x-pdf") return "pdf";
  if (file.type === "text/plain") return "text";
  return null;
}
