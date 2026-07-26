# EPUB → XTC 変換機能 実装仕様書

対象リポジトリ: `aGFydWtp/html2xtc`  
対象ブランチ: `main`  
目的: 既存の URL / PDF / TXT → XTC 変換機能に、EPUB ファイルのアップロードおよび EPUB → XTC 変換を追加する。

---

## 1. 背景

本システムは現在、以下の入力を Xteink X3 向け XTC ファイルへ変換できる。

- URL
- PDF
- TXT

URL と TXT は、いったん X3 向けサイズの PDF を生成し、その PDF を既存の `xtctool` ベースの Container で XTC に変換する。

EPUB 対応でも同じ変換資産を再利用し、次のパイプラインを採用する。

```text
EPUBアップロード
  ↓
EPUBを安全に解析
  ↓
spine順に本文XHTMLを統合
  ↓
CSS・画像・ルビ等を保持した自己完結HTMLを生成
  ↓
Browser RunでPDF生成
  ↓
既存のPDF→XTC変換
  ↓
XTCをR2へ保存
```

EPUB から XTC を直接生成する実装は行わない。

---

## 2. スコープ

### 2.1 対応範囲

初期実装では以下を対応対象とする。

- EPUB 2
- EPUB 3
- リフロー型 EPUB
- DRM なし EPUB
- XHTML 本文
- EPUB 内 CSS
- JPEG / PNG / GIF / WebP / SVG 画像
- HTML の `<ruby>` / `<rt>` によるルビ
- CSS による縦書き
- CSS による横書き
- 章単位の改ページ
- OPF メタデータからのタイトル取得
- OPF メタデータからの著者取得
- EPUB 内目次を利用した章タイトルの抽出
- EPUB 内の相対参照解決
- X3 向け 528 × 792 ピクセル相当の PDF 生成
- 既存 XTC プレビュー、履歴、ダウンロード、ライブラリ保存との連携

### 2.2 非対応範囲

初期実装では以下を明示的に非対応とする。

- DRM 付き EPUB
- Fixed Layout EPUB
- Scripted EPUB
- JavaScript 実行
- 動画
- 音声
- 外部 Web コンテンツの埋め込み
- iframe
- フォーム
- MathML の完全再現
- SMIL Media Overlays
- EPUB 内の対話要素
- 埋め込みフォントの完全対応
- Adobe DRM 等の解除
- EPUB を XTC に直接変換する独自レンダラー

非対応要素が含まれる場合でも、危険な要素を除去したうえで本文変換を継続できる場合は、変換全体を失敗させず縮退動作する。

---

## 3. 設計方針

### 3.1 既存パイプラインの再利用

既存実装の以下を再利用する。

- Cloudflare Worker
- Cloudflare Workflows
- R2
- Browser Run
- `renderSelfStyledHtmlPdf`
- `convertInContainer`
- `storeXtcOutput`
- XTC ダウンロード
- XTC プレビュー
- ジョブ履歴
- ライブラリ保存
- レート制限
- 約 24 時間の一時ファイル保持方針

### 3.2 Worker と Container の責務

EPUB の解析は Worker / Workflow 側で行う。

Container には EPUB を渡さない。Container は従来どおり PDF → XTC 変換のみを担当する。

理由:

- Container の責務を PDF → XTC に限定できる
- EPUB の ZIP、XML、XHTML 処理を TypeScript でテストしやすい
- Browser Run への HTML 入力経路を既存 TXT 変換と共有できる
- EPUB ごとに Python ライブラリを増やさずに済む
- XTC 変換ロジックを変更せずに EPUB 対応できる

### 3.3 EPUB アセットの扱い

初期実装では EPUB 内画像と CSS アセットを可能な限り Data URL またはインライン CSS に変換し、自己完結 HTML を生成する。

```text
EPUB
  ├─ XHTML
  ├─ CSS
  └─ Images
       ↓
単一の自己完結HTML
```

外部 URL へのアクセスは禁止する。

将来、大容量 EPUB の HTML サイズが問題になった場合は、R2 上の一時アセット配信方式を別仕様として追加する。

---

## 4. API 仕様

## 4.1 エンドポイント

```http
POST /jobs/epub
```

EPUB ファイルをアップロードし、非同期変換ジョブを作成する。

### 4.1.1 リクエストヘッダー

| ヘッダー | 必須 | 内容 |
|---|---:|---|
| `Content-Type` | 必須 | `application/epub+zip` または `application/octet-stream` |
| `Content-Length` | 必須 | 正の整数 |
| `X-File-Name` | 任意 | 既存 PDF と同じ方式でエンコードしたファイル名 |
| `X-Epub-Options` | 任意 | Base64URL エンコードした JSON |

### 4.1.2 `X-Epub-Options`

デコード後の JSON 形式:

```json
{
  "layout": "auto",
  "font": "BIZ UDMincho",
  "fontSizePx": 22,
  "marginPx": 48,
  "chapterPageBreak": true,
  "includeCover": true,
  "includeTableOfContents": false
}
```

### 4.1.3 オプション型

```ts
export interface EpubConvertOptions {
  layout: "auto" | "horizontal" | "vertical";
  font: string;
  fontSizePx: number;
  marginPx: number;
  chapterPageBreak: boolean;
  includeCover: boolean;
  includeTableOfContents: boolean;
}
```

### 4.1.4 既定値

```ts
export const DEFAULT_EPUB_OPTIONS: EpubConvertOptions = {
  layout: "auto",
  font: "BIZ UDMincho",
  fontSizePx: 22,
  marginPx: 48,
  chapterPageBreak: true,
  includeCover: true,
  includeTableOfContents: false,
};
```

### 4.1.5 バリデーション

| 項目 | 条件 |
|---|---|
| `layout` | `auto`, `horizontal`, `vertical` のいずれか |
| `font` | 既存フォント名サニタイズを再利用 |
| `fontSizePx` | 12〜40 の整数 |
| `marginPx` | 0〜120 の整数 |
| `chapterPageBreak` | boolean |
| `includeCover` | boolean |
| `includeTableOfContents` | boolean |

不正な `X-Epub-Options` は 400 とする。URL 変換の `layout` / `font` のようなフェイルソフトではなく、アップロード系オプションとして厳格に検証する。

### 4.1.6 成功レスポンス

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
```

```json
{
  "jobId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "statusUrl": "/jobs/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

### 4.1.7 エラー

| HTTP | 条件 |
|---:|---|
| 400 | オプション不正、ファイル名不正、EPUB body なし |
| 411 | `Content-Length` なし |
| 413 | EPUB ファイルサイズ上限超過 |
| 415 | Content-Type 不正 |
| 422 | EPUB 構造不正、暗号化、Fixed Layout 等の非対応形式 |
| 429 | レート制限超過 |
| 500 | Workflow 作成失敗 |
| 503 | 変換機能無効、またはプラットフォーム障害 |

---

## 5. サイズ制限

以下の環境変数を追加する。

```ts
MAX_UPLOAD_EPUB_BYTES?: string;
MAX_EPUB_UNCOMPRESSED_BYTES?: string;
MAX_EPUB_ENTRY_BYTES?: string;
MAX_EPUB_ENTRIES?: string;
MAX_EPUB_HTML_BYTES?: string;
```

既定値:

| 変数 | 既定値 |
|---|---:|
| `MAX_UPLOAD_EPUB_BYTES` | 48 MiB |
| `MAX_EPUB_UNCOMPRESSED_BYTES` | 192 MiB |
| `MAX_EPUB_ENTRY_BYTES` | 32 MiB |
| `MAX_EPUB_ENTRIES` | 5000 |
| `MAX_EPUB_HTML_BYTES` | 32 MiB |

制限超過は決定的エラーとして扱い、Workflow で再試行しない。

---

## 6. データモデル変更

## 6.1 `ConvertSource`

`src/types.ts` を変更する。

```ts
export type ConvertSource =
  | { kind: "url"; url: string }
  | { kind: "pdf"; key: string; filename: string; size: number }
  | { kind: "text"; key: string; filename: string; size: number }
  | { kind: "epub"; key: string; filename: string; size: number };
```

## 6.2 `ConvertJobParams`

```ts
export interface ConvertJobParams {
  url?: string;
  source?: ConvertSource;
  mode?: ConvertMode;
  layout?: string;
  font?: string;
  pdfOptions?: PdfConvertOptions;
  textOptions?: TextConvertOptions;
  epubOptions?: EpubConvertOptions;
}
```

## 6.3 R2 キー

`src/jobs.ts` に追加する。

```ts
export function inputEpubKey(jobId: string): string {
  return `input/${jobId}/source.epub`;
}

export function epubHtmlKey(jobId: string): string {
  return `intermediate/${jobId}/epub.html`;
}

export function epubFontsCssKey(jobId: string): string {
  return `intermediate/${jobId}/epub-fonts.css`;
}
```

PDF は既存の `intermediatePdfKey(jobId)` を使用する。

---

## 7. EPUB アップロード処理

新規ファイル:

```text
src/epub-upload.ts
```

責務:

- Content-Type 検証
- Content-Length 検証
- ファイル名デコード
- 拡張子検証
- EPUB ZIP マジック確認
- R2 へのストリーム保存
- 保存サイズと Content-Length の一致確認
- エラー文言の統一

### 7.1 MIME

許可:

```text
application/epub+zip
application/octet-stream
```

`application/octet-stream` は `.epub` 拡張子がある場合のみ許可する。

### 7.2 ZIP マジック

先頭バイトが以下のいずれかであることを確認する。

```text
50 4B 03 04
50 4B 05 06
50 4B 07 08
```

ただし ZIP マジックだけでは EPUB と確定しない。詳細検証は Workflow 内の `prepare-epub` で行う。

### 7.3 保存

```text
input/{jobId}/source.epub
```

Workflow 作成に失敗した場合は保存済み EPUB を best effort で削除する。

---

## 8. EPUB 解析仕様

新規ファイル候補:

```text
src/epub/
  archive.ts
  container.ts
  opf.ts
  navigation.ts
  css.ts
  assets.ts
  sanitize.ts
  html.ts
  errors.ts
  types.ts
  index.ts
```

## 8.1 ZIP 展開

既存依存の `fflate` を使用する。

実装は以下の安全条件を満たすこと。

- 絶対パスを拒否
- `..` を含むパスを拒否
- NUL を含むパスを拒否
- バックスラッシュを `/` に正規化
- 同一正規化パスの重複を拒否
- エントリ数上限を検証
- 展開後合計サイズを検証
- 1 エントリのサイズ上限を検証
- directory entry を本文として扱わない
- 暗号化 ZIP エントリを拒否
- ZIP64 はライブラリで安全に扱えない場合、明示的に拒否

可能なら ZIP 全体の同期展開を避け、エントリごとに制限を検証する。`unzipSync()` を使う場合でも、アップロードサイズと展開後サイズ制限により Worker メモリ上限を超えない設計にする。

## 8.2 `mimetype`

EPUB 仕様に従い、ルートの `mimetype` を確認する。

期待値:

```text
application/epub+zip
```

末尾改行や BOM は許容せず、完全一致を基本とする。

ただし実在 EPUB との互換性を優先する場合は、ASCII 空白の trim 後一致まで許容してよい。許容ルールはテストに固定する。

## 8.3 `META-INF/container.xml`

必須ファイル:

```text
META-INF/container.xml
```

`rootfile` の `full-path` から package document を特定する。

複数 rootfile がある場合:

1. `media-type="application/oebps-package+xml"` を優先
2. 最初の有効な rootfile を使用
3. すべて無効なら 422

XML パーサーとして `linkedom` を使用する。

外部実体参照、DTD、XXE は処理しない。文字列内に `<!DOCTYPE` または `<!ENTITY` が存在する場合は拒否または除去する。

## 8.4 OPF

package document から以下を取得する。

- version
- metadata
- manifest
- spine
- guide
- rendition properties

取得するメタデータ:

```text
dc:title
dc:creator
dc:language
dc:identifier
meta[property="rendition:layout"]
meta[property="rendition:orientation"]
meta[property="rendition:spread"]
```

### 8.4.1 タイトル

優先順位:

1. 最初の空でない `dc:title`
2. ファイル名から `.epub` を除いた値
3. `"EPUB document"`

前後空白を除去し、制御文字を除去し、100 文字に制限する。

### 8.4.2 著者

空でない `dc:creator` を文書順に取得し、最大 3 名まで `" / "` で連結する。

100 文字に制限する。

### 8.4.3 Fixed Layout 判定

以下の場合は初期実装では 422 とする。

```xml
<meta property="rendition:layout">pre-paginated</meta>
```

EPUB 2 の固定レイアウト系メタデータも既知のものを検出する。

エラーコード例:

```json
{
  "error": "fixed-layout EPUB is not supported"
}
```

## 8.5 manifest

manifest item ごとに以下を保持する。

```ts
interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: Set<string>;
  absolutePath: string;
}
```

`href` は OPF の位置を基準に解決する。

URL デコード後のパスが archive 外へ出る場合は拒否する。

同一 `id` の重複は不正 EPUB とする。

同一解決先パスの重複は許可してよいが、最初の item を基準に扱う。

## 8.6 spine

`itemref@idref` を manifest item に解決する。

以下を本文候補とする。

```text
application/xhtml+xml
text/html
```

原則として `linear="no"` の item は除外する。

ただし `includeTableOfContents=true` の場合、navigation document を別途目次として挿入するため、spine 内の目次ページを二重挿入しない。

spine が空の場合は 422 とする。

## 8.7 Navigation

EPUB 3:

```text
properties="nav"
```

EPUB 2:

```text
application/x-dtbncx+xml
```

目次情報は初期実装で次の用途に使う。

- `includeTableOfContents=true` の場合の目次生成
- spine item ごとの章タイトル推定
- ジョブログまたは将来機能向けの章情報

目次解析に失敗しても本文変換は継続する。

---

## 9. XHTML サニタイズ

各 spine item の XHTML を DOM 化し、`body` の内容を抽出する。

以下を削除する。

```text
script
iframe
frame
frameset
object
embed
applet
form
input
button
select
textarea
video
audio
source[動画・音声用途]
canvas
noscript
base
meta[http-equiv]
link[rel=preload]
link[rel=prefetch]
```

すべての `on*` イベント属性を削除する。

以下の URL スキームは禁止する。

```text
javascript:
vbscript:
file:
filesystem:
blob:
http:
https:
ftp:
```

EPUB 内部の相対参照だけを解決対象とする。

`data:` は、実装が生成した画像 Data URL のみ許可する。入力 XHTML に元から存在する `data:` URL は、許可 MIME とサイズを検証するか、初期実装では削除する。

### 9.1 ID の衝突

複数 XHTML を単一 HTML に結合するため、ID を章ごとに namespace 化する。

例:

```text
chapter-0001--section-1
chapter-0002--section-1
```

以下を書き換える。

- `id`
- `href="#..."`
- `aria-labelledby`
- `aria-describedby`
- SVG 内のローカル参照
- CSS の ID selector は可能な範囲で対応

完全な CSS selector 書き換えが困難な場合、初期実装では XHTML ごとに `<section>` で分け、ID selector の衝突を既知制限として文書化する。ただしアンカーリンクは正しく書き換える。

### 9.2 章ラッパー

各 spine item を以下のようにラップする。

```html
<section
  class="epub-spine-item"
  data-spine-index="0"
  aria-label="章タイトル"
>
  ...
</section>
```

`chapterPageBreak=true` の場合:

```css
.epub-spine-item + .epub-spine-item {
  break-before: page;
  page-break-before: always;
}
```

---

## 10. CSS 処理

## 10.1 CSS 収集

各 XHTML の以下から CSS を収集する。

```html
<link rel="stylesheet" href="...">
<style>...</style>
```

manifest 上で `text/css` の CSS のみ読み込む。

## 10.2 CSS の安全化

以下を除去する。

- `@import`
- `behavior`
- `-moz-binding`
- 外部 URL
- `javascript:` URL
- `expression()`
- `url()` 内の archive 外参照
- `position: fixed` は必要に応じて `static` に変換
- 極端な負の margin
- print を破壊する巨大サイズ

CSS パーサー依存を追加しない場合、単純な正規表現だけで安全性を保証しないこと。

推奨:

- 軽量 CSS parser を追加する
- または許可プロパティ方式の sanitizer を実装する

新規依存を追加する場合は、ライセンスと Cloudflare Workers 互換性を確認する。

## 10.3 CSS URL

CSS 内の EPUB アセット参照:

```css
background-image: url("../Images/foo.png");
```

を Data URL に置換する。

フォント参照:

```css
@font-face {
  src: url("../Fonts/foo.otf");
}
```

初期実装では以下のいずれかとする。

### 推奨

EPUB 埋め込みフォントの `@font-face` を削除し、ユーザー指定の Google Fonts または汎用フォントを使用する。

理由:

- フォントライセンスを継承して再埋め込みする問題を避ける
- HTML サイズを抑える
- Browser Run でのフォント形式互換問題を避ける
- EPUB 内フォントの難読化対応が不要

## 10.4 EPUB 独自組版の尊重

以下は可能な限り保持する。

- `writing-mode`
- `text-orientation`
- `text-combine-upright`
- `text-emphasis`
- `ruby-position`
- `break-before`
- `break-after`
- `page-break-before`
- `page-break-after`
- `white-space`
- `text-align`
- `line-height`

ただし X3 向けの可読性を優先し、文書全体へ最終上書き CSS を追加する。

---

## 11. 画像処理

許可 MIME:

```text
image/jpeg
image/png
image/gif
image/webp
image/svg+xml
```

### 11.1 Data URL 化

ラスター画像:

```text
data:<media-type>;base64,<bytes>
```

SVG:

- XML を解析
- script を削除
- イベント属性を削除
- 外部 URL を削除
- foreignObject を削除
- archive 内参照は可能な範囲で Data URL 化
- 安全化後に Data URL 化

### 11.2 画像表示 CSS

```css
img,
svg {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  break-inside: avoid;
}

figure {
  break-inside: avoid;
}
```

### 11.3 表紙

表紙の優先判定:

1. manifest の `properties="cover-image"`
2. EPUB 2 の `<meta name="cover" content="...">`
3. guide の `type="cover"`
4. cover.xhtml 内の最初の画像

`includeCover=false` の場合は表紙専用 item を除外する。

表紙と本文先頭が同一 spine item の場合は削除しない。

---

## 12. レイアウト判定

`layout="auto"` の場合、以下の優先順位で決定する。

1. OPF の `rendition:layout`
2. package / spine / XHTML の `page-progression-direction`
3. 文書 CSS の `writing-mode`
4. `dc:language`
5. 既定値 horizontal

縦書き判定例:

- `writing-mode: vertical-rl`
- `page-progression-direction="rtl"` かつ言語が日本語
- `dc:language` が `ja` で、主要 CSS に縦書き指定がある

日本語だから自動的に縦書きにはしない。

ユーザーが `horizontal` または `vertical` を明示した場合は、その指定を優先する。

### 12.1 最終 CSS

横書き:

```css
html,
body {
  writing-mode: horizontal-tb;
  text-orientation: mixed;
}
```

縦書き:

```css
html,
body {
  writing-mode: vertical-rl;
  text-orientation: mixed;
}
```

明示レイアウトは `!important` を使って EPUB CSS より優先してよい。

`auto` は EPUB CSS を尊重し、不足部分のみ補完する。

---

## 13. X3 向け HTML

新規関数:

```ts
export interface PreparedEpubDocument {
  html: string;
  title: string;
  author?: string;
  layout: "horizontal" | "vertical";
  spineItemCount: number;
  imageCount: number;
  warnings: EpubWarning[];
}
```

生成 HTML の基本形:

```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>...</title>
  <style>
    /* EPUB CSS */
  </style>
  <style>
    /* X3向け補正CSS */
  </style>
</head>
<body>
  <section class="epub-cover">...</section>
  <nav class="epub-generated-toc">...</nav>
  <main class="epub-book">
    <section class="epub-spine-item">...</section>
  </main>
  <section class="epub-colophon">...</section>
</body>
</html>
```

### 13.1 ページサイズ

```css
@page {
  size: 528px 792px;
  margin: 0;
}

html,
body {
  width: 528px;
  min-height: 792px;
  margin: 0;
  padding: 0;
}

.epub-book {
  box-sizing: border-box;
  padding: var(--epub-margin);
}
```

Browser Run の PDF 出力と既存 `xtctool` の 528 × 792 設定が二重に拡大縮小しないことをテストする。

### 13.2 フォント

既存 `buildInlineFontCss()` を使用する。

EPUB 側の CSS より優先するため、以下を最終 CSS に追加する。

```css
html,
body,
.epub-book {
  font-family: "<選択フォント>", serif !important;
}
```

ただしコード、pre、kbd 等は monospace を維持してよい。

### 13.3 奥付

EPUB では URL が存在しないため、次の情報を表示する。

```text
タイトル
著者
入力形式: EPUB
元ファイル名
変換日時
個人的利用のために作成。再配布禁止。
Created for personal use. Redistribution prohibited.
```

---

## 14. Workflow

`src/workflow.ts` に `runEpubSource()` を追加する。

分岐:

```ts
if (source.kind === "epub") {
  return await this.runEpubSource(
    jobId,
    source,
    event.payload.epubOptions ?? DEFAULT_EPUB_OPTIONS,
    step,
  );
}
```

## 14.1 Workflow ステップ

```text
prepare-epub
render-epub-pdf
convert-xtc
delete-epub-intermediates
```

### 14.1.1 `prepare-epub`

処理:

1. R2 から EPUB を取得
2. サイズ再確認
3. EPUB 解析
4. 自己完結 HTML 生成
5. フォント CSS 生成
6. HTML を R2 保存
7. フォント CSS を R2 保存
8. 小さいメタデータのみ step output に返す

step output:

```ts
{
  articleKey: string;
  fontsKey: string | null;
  title: string;
  author?: string;
  layout: "horizontal" | "vertical";
  spineItemCount: number;
  warnings: string[];
}
```

EPUB 本体や HTML を step output に含めない。

タイムアウト:

```text
3 minutes
```

リトライ:

```ts
retries: {
  limit: 1,
  delay: "5 seconds",
  backoff: "constant"
}
```

構造不正、暗号化、サイズ超過、Fixed Layout は `NonRetryableError`。

R2 やフォント取得の一時障害は retryable。

### 14.1.2 `render-epub-pdf`

処理:

1. HTML を R2 から取得
2. フォント CSS を取得
3. `renderSelfStyledHtmlPdf()` で PDF 化
4. PDF サイズを検証
5. `intermediatePdfKey(jobId)` に保存

タイムアウト:

```text
7 minutes
```

リトライ:

```ts
retries: {
  limit: 2,
  delay: "10 seconds",
  backoff: "exponential"
}
```

PDF サイズ超過は `NonRetryableError`。

### 14.1.3 `convert-xtc`

既存 URL / TXT と同じ処理を再利用する。

`convertInContainer()` に以下を渡す。

- PDF stream
- jobId
- title
- author

必要に応じて `convertInContainer` の API を一般化し、EPUB から取得した title / author を `X-Xtc-Title` / `X-Xtc-Author` で Container に渡す。

現在 PDF metadata だけでタイトルを渡している経路と重複しないよう整理する。

### 14.1.4 `delete-epub-intermediates`

成功・失敗にかかわらず削除する。

対象:

```text
input/{jobId}/source.epub
intermediate/{jobId}/epub.html
intermediate/{jobId}/epub-fonts.css
intermediate/{jobId}.pdf
```

削除失敗はジョブ失敗にしない。

R2 lifecycle による最終削除も維持する。

---

## 15. ジョブ状態

EPUB ジョブの表示状態:

```text
queued
preparing
rendering
converting
completed
failed
expired
```

既存 API のレスポンス形式は維持する。

`GET /jobs/:jobId` の内部状態推定では、以下の順に R2 を確認する。

1. EPUB 入力が存在し、HTML がない → `preparing`
2. HTML が存在し、PDF がない → `rendering`
3. PDF が存在する → `converting`
4. XTC が存在する → `completed`

R2 probe の瞬間的な不整合は許容し、次回ポーリングで自己修復する。

フロントの i18n には「EPUB解析中」を追加する。

---

## 16. フロントエンド

## 16.1 ファイル選択

`FileDropZone.svelte` の既定 accept を変更する。

```text
text/plain,.txt,
application/pdf,.pdf,
application/epub+zip,.epub
```

実際の文字列は 1 行で指定する。

## 16.2 ファイル判定

`ConvertForm.svelte` の判定を enum 化する。

```ts
type InputFileKind = "pdf" | "text" | "epub";
```

優先順位:

1. `.epub`
2. `.pdf`
3. `.txt`
4. MIME
5. 不明ならエラー

EPUB を TXT と誤判定しないこと。

## 16.3 クライアント検証

新規:

```text
frontend/src/lib/epub-file-validate.ts
```

検証:

- 拡張子
- MIME
- ファイルサイズ
- ZIP マジック
- 空ファイル

ブラウザ側検証は UX 用であり、サーバー側検証を省略しない。

## 16.4 EPUB パネル

新規:

```text
frontend/src/components/EpubInputPanel.svelte
```

表示項目:

- ファイル名
- ファイルサイズ
- レイアウト
  - EPUBに従う
  - 横書き
  - 縦書き
- フォント
- 文字サイズ
- 余白
- 章ごとに改ページ
- 表紙を含める
- 目次を含める
- 変換開始
- アップロード進捗
- キャンセル
- ファイルを取り除く

初期値は `DEFAULT_EPUB_OPTIONS` と一致させる。

## 16.5 アップロード

`frontend/src/lib/convert.svelte.ts` に追加する。

```ts
export function submitEpub(
  file: File,
  options: EpubConvertOptions,
  onProgress: EpubUploadProgress,
  displayTitle?: string,
): EpubUploadSession;
```

PDF / TXT と同じ XMLHttpRequest ベースで実装する。

```http
POST /jobs/epub
Content-Type: application/epub+zip
X-File-Name: ...
X-Epub-Options: ...
```

## 16.6 履歴

`JobEntry.sourceType` に `"epub"` を追加する。

```ts
type SourceType = "url" | "pdf" | "text" | "epub";
```

表示ラベル:

```text
EPUB
```

履歴、CurrentJob、Library 自動保存で既存動作を維持する。

---

## 17. エラー設計

EPUB 内の原文、HTML、ファイルパスをクライアント向けエラーへ含めない。

ログには必要最小限の構造情報のみを含める。

### 17.1 安定エラーコード

内部では次のコードを定義する。

```ts
type EpubErrorCode =
  | "INVALID_ZIP"
  | "INVALID_MIMETYPE"
  | "MISSING_CONTAINER"
  | "INVALID_CONTAINER"
  | "MISSING_PACKAGE"
  | "INVALID_PACKAGE"
  | "EMPTY_SPINE"
  | "MISSING_SPINE_ITEM"
  | "ENCRYPTED_EPUB"
  | "FIXED_LAYOUT_UNSUPPORTED"
  | "TOO_MANY_ENTRIES"
  | "ENTRY_TOO_LARGE"
  | "UNCOMPRESSED_SIZE_TOO_LARGE"
  | "HTML_TOO_LARGE"
  | "UNSAFE_PATH"
  | "UNSUPPORTED_ARCHIVE";
```

クライアント向けメッセージ例:

| コード | メッセージ |
|---|---|
| `INVALID_ZIP` | `invalid EPUB file` |
| `MISSING_CONTAINER` | `EPUB package information is missing` |
| `EMPTY_SPINE` | `EPUB contains no readable content` |
| `ENCRYPTED_EPUB` | `encrypted EPUB is not supported` |
| `FIXED_LAYOUT_UNSUPPORTED` | `fixed-layout EPUB is not supported` |
| サイズ系 | `EPUB is too large to convert` |

---

## 18. セキュリティ要件

以下を必須とする。

- SSRF を発生させない
- EPUB 内の外部 URL を取得しない
- JavaScript を実行しない
- iframe を生成しない
- ZIP Slip を防止する
- ZIP bomb を防止する
- XML External Entity を無効化する
- CSS の外部 URL を削除する
- SVG の script と外部参照を削除する
- data URL の MIME を制限する
- アップロードファイルを Container へ直接渡さない
- EPUB 原文をエラーレスポンスに含めない
- 一時ファイルを成功・失敗の両方で削除する
- レート制限を適用する
- 既存の `CONVERSION_MODE=disabled` を適用する
- ファイル名を R2 key に直接使用しない
- パスは archive 内の POSIX path として正規化する
- `Content-Length` と保存サイズを照合する

---

## 19. テスト

## 19.1 Unit Test

### Archive

```text
test/epub/archive.test.ts
```

- 正常 ZIP
- ZIP マジック不正
- path traversal
- absolute path
- backslash path
- 重複 path
- エントリ数超過
- 展開後サイズ超過
- 単一 entry サイズ超過
- 暗号化 entry
- 空 archive

### Container XML

```text
test/epub/container.test.ts
```

- 正常 rootfile
- container.xml なし
- XML 不正
- 複数 rootfile
- OPF path traversal
- DOCTYPE
- ENTITY

### OPF

```text
test/epub/opf.test.ts
```

- EPUB 2
- EPUB 3
- title / creator
- manifest
- spine
- linear=no
- fixed layout
- cover
- nav
- NCX
- 重複 ID
- 空 spine
- 不正 href

### XHTML sanitize

```text
test/epub/sanitize.test.ts
```

- script 除去
- onload 除去
- iframe 除去
- javascript URL 除去
- http URL 除去
- 相対画像 Data URL 化
- ruby 保持
- 縦中横保持
- SVG sanitize
- ID namespace
- fragment link 書き換え

### CSS

```text
test/epub/css.test.ts
```

- `@import` 除去
- 外部 `url()` 除去
- 相対画像 Data URL 化
- `javascript:` 除去
- writing-mode 保持
- font-face 除去
- malformed CSS

### HTML generation

```text
test/epub/html.test.ts
```

- spine 順
- 章改ページ
- 表紙
- 目次
- 横書き
- 縦書き
- auto layout
- 奥付
- title / author
- HTML サイズ制限

### Options

```text
test/epub-options.test.ts
```

- encode / decode
- 既定値
- 不正 layout
- font size 範囲
- margin 範囲
- boolean 型不正

### Upload

```text
test/epub-upload.test.ts
```

- Content-Type
- Content-Length
- サイズ超過
- ZIP magic
- R2 保存
- 保存失敗
- Workflow 作成失敗時削除

### Workflow

```text
test/workflow-epub.test.ts
```

- 正常フロー
- prepare retry
- deterministic error は非 retry
- render retry
- PDF サイズ超過
- convert retry
- success cleanup
- failure cleanup
- title / author 伝搬

## 19.2 Frontend Test

- EPUB 選択
- EPUB を TXT と誤認しない
- 不正ファイル表示
- EPUB パネル表示
- オプション変更
- アップロード進捗
- キャンセル
- ジョブ履歴登録
- preparing 表示
- completed 表示
- failed 表示
- i18n 日本語 / 英語

## 19.3 Fixture

ライセンス上問題のない最小 EPUB fixture をリポジトリ内で生成する。

例:

```text
test/fixtures/epub/
  minimal-horizontal.epub
  minimal-vertical.epub
  ruby.epub
  images.epub
  epub2-ncx.epub
  epub3-nav.epub
  fixed-layout.epub
  unsafe-path.epub
  external-assets.epub
  scripted.epub
```

バイナリを直接管理するより、テスト時に ZIP を生成する helper を優先する。

## 19.4 Integration Test

少なくとも以下を実施する。

1. EPUB を `/jobs/epub` へアップロード
2. Workflow 完了までポーリング
3. XTC をダウンロード
4. XTC header が有効
5. ページ数が 1 以上
6. XTC title が EPUB title と一致
7. XTC author が EPUB author と一致
8. XTC プレビューでページ描画可能
9. 入力 EPUB と中間 HTML / PDF が削除される

---

## 20. 受入条件

以下をすべて満たすこと。

### API

- [ ] `POST /jobs/epub` が存在する
- [ ] 有効な EPUB で 202 を返す
- [ ] 不正 EPUB で適切な 4xx を返す
- [ ] レート制限が適用される
- [ ] `CONVERSION_MODE=disabled` が適用される
- [ ] Content-Length 必須
- [ ] 最大アップロードサイズを超えると 413

### EPUB 解析

- [ ] EPUB 2 と EPUB 3 を解析できる
- [ ] spine 順を維持する
- [ ] 相対 XHTML / CSS / 画像参照を解決する
- [ ] 外部 URL を取得しない
- [ ] script を実行しない
- [ ] path traversal を拒否する
- [ ] ZIP bomb 制限がある
- [ ] Fixed Layout を明示的に拒否する
- [ ] title / author を取得する

### 組版

- [ ] 横書き EPUB が読める
- [ ] 縦書き EPUB が読める
- [ ] ルビが保持される
- [ ] 画像が表示される
- [ ] 章改ページを選べる
- [ ] 表紙の有無を選べる
- [ ] 目次の有無を選べる
- [ ] X3 の表示領域に収まる

### XTC

- [ ] 既存 Container で変換される
- [ ] XTC プレビューが動作する
- [ ] タイトルが XTC メタデータへ入る
- [ ] 著者が XTC メタデータへ入る
- [ ] ダウンロードできる
- [ ] ライブラリ保存できる

### クリーンアップ

- [ ] 成功時に入力 EPUB を削除する
- [ ] 失敗時にも入力 EPUB を削除する
- [ ] 中間 HTML / CSS / PDF を削除する
- [ ] 削除失敗で変換結果を失敗扱いにしない
- [ ] lifecycle による最終削除が設定される

### 品質

- [ ] TypeScript typecheck 成功
- [ ] Worker test 成功
- [ ] Frontend check 成功
- [ ] Frontend test 成功
- [ ] Converter test 成功
- [ ] 既存 URL / PDF / TXT の回帰がない
- [ ] README に EPUB API と UI を追記
- [ ] 非対応範囲を README に明記

---

## 21. 実装順序

以下の順序で実装する。

### Phase 1: 型・オプション・アップロード

1. `EpubConvertOptions`
2. `ConvertSource.kind = "epub"`
3. R2 key
4. `epub-upload.ts`
5. `POST /jobs/epub`
6. Unit test

### Phase 2: EPUB parser

1. archive validation
2. container.xml
3. OPF
4. manifest / spine
5. metadata
6. navigation
7. Unit test

### Phase 3: HTML 生成

1. XHTML sanitize
2. asset Data URL 化
3. CSS sanitize
4. ID / fragment 書き換え
5. cover
6. TOC
7. layout
8. X3 CSS
9. Unit test

### Phase 4: Workflow

1. `runEpubSource`
2. prepare step
3. render step
4. existing convert step reuse
5. cleanup
6. status probe
7. Workflow test

### Phase 5: Frontend

1. file detection
2. file validation
3. EPUB panel
4. upload
5. progress / cancel
6. history
7. i18n
8. Frontend test

### Phase 6: 統合・文書

1. integration fixture
2. end-to-end conversion
3. XTC metadata
4. preview
5. cleanup
6. README
7. regression test

---

## 22. 実装時の禁止事項

- EPUB を無検証で unzip しない
- `../` を含む entry を展開しない
- EPUB 内の JavaScript を Browser Run で実行しない
- EPUB 内の外部 HTTP URL を Browser Run に取得させない
- EPUB 全体や生成 HTML を Workflow step output に格納しない
- EPUB を Container に直接渡さない
- EPUB 固有処理を既存 PDF 変換処理へ混在させない
- 既存 URL / PDF / TXT API の互換性を壊さない
- エラーに本文や EPUB 内部パスをそのまま返さない
- 一時ファイルを Workflow 完了後も意図的に残さない
- Fixed Layout をリフロー型として黙って処理しない
- CSS の安全化を正規表現 1 本だけで済ませない

---

## 23. 完了時に実装エージェントが報告する内容

実装完了時、以下を報告すること。

1. 変更ファイル一覧
2. API 仕様の実装内容
3. EPUB parser の対応範囲
4. セキュリティ対策
5. 非対応項目
6. 追加した環境変数
7. 実行したテスト
8. テスト結果
9. 手動確認した EPUB
10. 既知の制限
11. 将来改善候補
12. 既存 URL / PDF / TXT の回帰確認結果

---

## 24. 将来拡張候補

初期実装には含めない。

- Fixed Layout EPUB 対応
- EPUB 内埋め込みフォント対応
- 大容量 EPUB の R2 一時アセット配信
- 章選択
- ページ範囲指定
- CSS テーマ選択
- EPUB 目次を XTC 内ナビゲーションへ反映
- SVG の高度な再現
- MathML の画像化
- 表紙だけ別 threshold を適用
- EPUB preview
- OPDS から EPUB を直接取得して変換
- ライブラリ内 EPUB 原本の保存
- EPUB → PDF の中間成果物ダウンロード
