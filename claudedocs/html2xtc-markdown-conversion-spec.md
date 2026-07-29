# html2xtc Markdown入力対応 実装仕様書

- 対象リポジトリ: `aGFydWtp/html2xtc`
- 調査対象ブランチ: `main`
- 調査対象コミット: `d56747d3338ec5ac6b9e9d27032af6de15ea630b`
- 作成日: 2026-07-27
- 想定読者: 実装エージェント、レビュー担当者
- 実装規模: 中
- 技術的実現性: **可能**

## 1. 結論

既存のテキスト変換機能へ、`inputFormat: "markdown"` を第3の入力形式として追加できる。

現在のテキスト変換は、次の構造になっている。

```text
TXTアップロード
  → 文字コード判定・デコード
  → prepareTextDocument()
      ├─ plain
      └─ aozora
  → 自己完結HTML
  → Browser RenderingでPDF化
  → 既存ContainerでPDF→XTC
```

Markdown対応は主として `prepareTextDocument()` の前半に新しい分岐を加える変更であり、PDF生成、Container、`xtctool`、XTC保存処理はそのまま再利用できる。

実装後は次の構造とする。

```text
テキストファイルアップロード
  → 文字コード判定・デコード
  → prepareTextDocument()
      ├─ plain
      ├─ aozora
      └─ markdown
  → 自己完結HTML
  → Browser RenderingでPDF化
  → 既存ContainerでPDF→XTC
```

## 2. 背景

現状の `POST /jobs/text` は、`X-Text-Options` の `inputFormat` により以下を切り替える。

- `plain`: HTML、Markdown、青空文庫記法を一切解釈しない
- `aozora`: 青空文庫形式のASTパーサー・レンダラーを使用する

Markdownを追加する場合も、新しいアップロードAPIや新しい変換基盤を作らず、既存の `POST /jobs/text` と `source.kind === "text"` のWorkflowを継続利用する。

## 3. 目的

以下を満たすMarkdownファイル変換を提供する。

1. `.md`、`.markdown`、およびMarkdownとして明示されたテキストをXTCへ変換できる
2. Markdownの主要な文書構造を読書向けに組版できる
3. 任意HTML、スクリプト、外部画像などを実行・取得しない
4. 横書き・縦書き、フォント、文字サイズ、余白など、既存のテキスト変換設定を利用できる
5. 本番変換とX3実機プレビューが同じMarkdown変換ロジックを使う
6. Markdown見出しからXTCの章情報を生成できる
7. `plain` と `aozora` の既存挙動を変更しない

## 4. 非目標

MVPでは以下を実装しない。

- Markdown内の生HTMLの実行・描画
- Markdownと青空文庫記法の混在解釈
- 外部画像・ローカル画像の取得または埋め込み
- Mermaid、PlantUML、Graphviz
- 数式レンダリング
- シンタックスハイライト
- YAML/TOML front matterの解釈
- 脚注プラグイン
- GitHubのタスクリストUI
- Markdown拡張プラグインのユーザー指定
- Markdown内CSS
- Markdown内JavaScript
- リンク先ページの取得
- Markdownファイルと画像フォルダをまとめたZIP入力
- MarkdownからEPUBを経由する変換

## 5. 基本設計

### 5.1 入力形式

`TextInputFormat` を次のように拡張する。

```ts
export type TextInputFormat = "plain" | "aozora" | "markdown";
```

対象箇所:

- `src/text-options.ts`
- `frontend/src/lib/text-options.ts`
- 関連するテスト
- READMEのAPI仕様

互換性要件:

- `inputFormat` が省略された場合は、従来どおり `"plain"`
- `"plain"` と `"aozora"` の意味は変更しない
- 未知の値は従来どおり400
- 保存済み・旧クライアント由来のオプションを壊さない

### 5.2 API

新しいエンドポイントは作らない。

```http
POST /jobs/text
```

Markdownの場合も、既存の `X-Text-Options` に以下を指定する。

```json
{
  "inputFormat": "markdown",
  "encoding": "auto",
  "layout": "horizontal",
  "font": "BIZ UDPGothic",
  "fontSizePx": 26,
  "lineHeight": 1.8,
  "paragraphSpacingEm": 0.9,
  "margins": {
    "top": 36,
    "right": 32,
    "bottom": 40,
    "left": 32
  },
  "textAlign": "start",
  "maxConsecutiveBlankLines": 2,
  "preserveSpaces": false,
  "joinHardWrappedLines": true,
  "showPageNumbers": false,
  "title": "",
  "author": ""
}
```

サーバー側の許可Content-Typeへ以下を追加する。

```text
text/markdown
```

引き続き以下も受け付ける。

```text
text/plain
application/octet-stream
```

WebUIは既存実装との互換性を優先し、Markdownファイルでも `Content-Type: text/plain` で送信してよい。API直利用者向けに `text/markdown` を許可する。

### 5.3 ファイル拡張子

テキスト入力として以下を許可する。

- `.txt`
- `.md`
- `.markdown`

MIMEとして以下を許可する。

- 空文字
- `text/plain`
- `text/markdown`

`InputFileKind` は新しい種類を増やさず、Markdownも既存の `"text"` として扱う。履歴の `sourceType: "txt"` もMVPでは変更しない。

### 5.4 自動判定

Markdownの本文内容による推測は行わない。`#`、`*`、`-` だけでは通常の文章を誤判定しやすいためである。

初期形式の優先順位は次のとおり。

1. ユーザーが形式を手動変更済みなら、その選択を維持
2. ファイル名が `.md` または `.markdown` なら `"markdown"`
3. MIMEが `text/markdown` なら `"markdown"`
4. 青空文庫形式の高信頼判定に一致したら `"aozora"`
5. それ以外は `"plain"`

手動選択では `.txt` をMarkdownとして変換することも、`.md` をプレーンテキストとして変換することも許可する。

## 6. Markdownパーサー

### 6.1 採用ライブラリ

`markdown-it` を使用する。

採用理由:

- Node.jsとブラウザの両方で利用できる
- CommonMark互換の基礎構文を扱える
- 生HTMLを無効化できる
- トークン列を取得でき、章見出し抽出と安全な独自レンダラーを実装しやすい
- テーブルと取り消し線を標準プリセットで扱える
- レンダラールールを上書きできる

依存バージョンはルートと `frontend/` で**同一の完全固定バージョン**にする。`^` や `~` を付けず、両方のlockfileに同じ版を記録する。

追加先:

- ルート `package.json`
  - `dependencies`: `markdown-it`
  - `devDependencies`: 必要なら `@types/markdown-it`
- `frontend/package.json`
  - `dependencies`: `markdown-it`
  - `devDependencies`: 必要なら `@types/markdown-it`

### 6.2 設定

以下を明示する。

```ts
const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
  xhtmlOut: false,
  maxNesting: 50,
});
```

要件:

- `html: false` は必須
- `linkify: false` は必須
- `typographer: false` とし、原文文字を勝手に置換しない
- `breaks: false` とし、CommonMarkの改行規則に従う
- `maxNesting` を50以下に制限する
- 任意プラグインを追加しない

### 6.3 共有実装

バックエンドとフロントエンドで、Markdownの解釈規則・安全なHTML生成・章抽出を共有する。

推奨構成:

```text
packages/
  markdown-text/
    src/
      index.ts
      renderer.ts
      plain-text.ts
      chapters.ts
      styles.ts
      types.ts
```

フロントエンドは次のaliasで参照する。

```text
@html2xtc/markdown-text
```

`frontend/tsconfig.json` と `frontend/vite.config.ts` に、既存の `@html2xtc/aozora-text` と同様のaliasを追加する。

ただし `packages/markdown-text` 自体から `markdown-it` を直接bare importすると、ルートと `frontend/` の独立した `npm ci` で解決元が不安定になる可能性がある。次の構成を採る。

- ルート側とフロントエンド側が、それぞれ自分の `markdown-it` をimportする
- 共有パッケージへMarkdownItインスタンスまたはコンストラクタを注入する
- パーサー設定、token走査、レンダラールールの実体は共有パッケージ側に置く
- 共有パッケージは `markdown-it` の具体パッケージ解決に依存せず、必要な最小構造を型として定義する

概念例:

```ts
import MarkdownIt from "markdown-it";
import { createMarkdownConverter } from "@html2xtc/markdown-text";

export const markdownConverter = createMarkdownConverter(
  () =>
    new MarkdownIt({
      html: false,
      linkify: false,
      typographer: false,
      breaks: false,
      xhtmlOut: false,
      maxNesting: 50,
    }),
);
```

APIの具体名は変更してよいが、変換ロジックをバックエンドとフロントエンドへコピーしないこと。

## 7. 対応構文

MVPで以下を対応する。

| Markdown | 出力 |
|---|---|
| 段落 | `<p>` |
| ATX見出し | `<h1>`〜`<h6>` |
| Setext見出し | `<h1>`、`<h2>` |
| 強調 | `<em>` |
| 太字 | `<strong>` |
| 取り消し線 | `<s>` |
| 順序なしリスト | `<ul><li>` |
| 順序付きリスト | `<ol><li>` |
| 入れ子リスト | 入れ子の`ul`/`ol` |
| 引用 | `<blockquote>` |
| インラインコード | `<code>` |
| fenced code block | `<pre><code>` |
| indented code block | `<pre><code>` |
| 水平線 | `<hr>` |
| テーブル | `<table>`系 |
| Markdownリンク | 表示文字列のみ |
| CommonMark autolink | URL文字列のみ |
| 画像 | 代替テキストのプレースホルダー |
| soft break | 通常の空白または改行規則 |
| hard break | `<br>` |
| HTML | エスケープ済みの文字列 |

### 7.1 リンク

外部アクセスを発生させないため、`href` を出力しない。

```md
[Cloudflare](https://www.cloudflare.com/)
```

出力イメージ:

```html
<span class="md-link">Cloudflare</span>
```

URL自体がラベルになっているautolinkは、そのURL文字列だけが見える。

```md
<https://example.com/>
```

出力イメージ:

```html
<span class="md-link">https://example.com/</span>
```

`javascript:` などのスキームを特別扱いして通す処理を作らない。そもそもリンク属性を生成しない。

### 7.2 画像

`<img>` を出力しない。画像URLへアクセスしない。

```md
![構成図](./architecture.png)
```

出力イメージ:

```html
<span class="md-image-placeholder">［画像: 構成図］</span>
```

代替テキストが空の場合:

```html
<span class="md-image-placeholder">［画像］</span>
```

画像のURL・パスは表示しない。

### 7.3 生HTML

以下は実行可能なタグにしない。

```md
<script>alert(1)</script>
<img src="https://example.com/a.png" onerror="alert(1)">
<style>body { display:none }</style>
<iframe src="https://example.com"></iframe>
```

出力HTMLには `script`、`style`、`iframe`、`img`、イベント属性、任意属性を含めない。利用者にはエスケープ済みテキストとして見える。

## 8. Markdown正規化

Markdownは空白・改行・インデント自体が構文であるため、`plain` 用の `normalizeText()` をそのまま適用してはならない。

新しくMarkdown専用の正規化関数を作る。

```ts
normalizeMarkdownSource(source: string)
```

処理するもの:

- UTF-8/Shift_JISのデコード後テキストを受ける
- CRLFとCRをLFへ統一
- 既存方針と同じ危険な制御文字を除去
- 末尾に改行がなくても許可
- 文字数・行数・1行長の既存上限を維持

処理しないもの:

- 連続空行の圧縮
- 行の自動連結
- 行頭空白の除去
- 行末空白の除去
- タブの空白変換
- fenced code block内の変更
- Markdownのhard break用末尾2空白の削除

Markdownでは次のオプションを無視する。

- `maxConsecutiveBlankLines`
- `preserveSpaces`
- `joinHardWrappedLines`

無視する値がAPIに含まれていても400にはしない。後方互換のため、`TextConvertOptions` のスキーマから削除しない。

`buildTextPrintCss()` の `white-space: pre-wrap` は、Markdownでは適用しない。`preserveSpaces === true` でもMarkdown出力全体を `pre-wrap` にしてはならない。

## 9. Markdown変換結果の型

共有パッケージは、少なくとも以下に相当する情報を返す。

```ts
export interface ParsedMarkdownDocument {
  contentHtml: string;
  plainText: string;
  firstH1?: string;
  chapters: XtcChapter[];
  chapterHeadingLevel: 1 | 2 | null;
  tokenCount: number;
}
```

要件:

- `contentHtml` は共有レンダラーだけが生成した安全なHTML断片
- `plainText` はフォントサブセット、空本文判定、検索可能文字列に使う
- `firstH1` は書誌タイトル候補
- `chapters` はXTC章情報
- `chapterHeadingLevel` はログ・観測用
- `tokenCount` は複雑度制限とログ用

### 9.1 HTMLブランド

`src/text-html.ts` の `SafeGeneratedHtml` を、Markdownレンダラーからも安全に生成できる構造へ拡張する。

任意文字列をキャストするだけのexport関数は作らない。

推奨方法:

- Markdown共有パッケージが安全な断片を生成する
- `src/text-html.ts` の `buildMarkdownContentHtml()` がその結果を受け、ブランドを付与する
- 型だけでなくテストで許可タグ・許可属性を検証する

## 10. タイトル・著者

### 10.1 タイトル優先順位

Markdown入力時の文書タイトルは次の順で決定する。

1. `options.title` のtrim後が空でなければ、その値
2. 最初の非空H1のプレーンテキスト
3. ファイル名から `.txt`、`.md`、`.markdown` を除いた値
4. `Untitled`

`resolveDocumentTitle()` を拡張し、上記拡張子を扱えるようにする。

### 10.2 本文ヘッダー

最初のH1をXTC/PDFメタデータ用タイトルに採用しても、同じ文字列を別の `book-header` として自動挿入しない。Markdown本文内のH1がそのまま表示されるためである。

`book-header` に表示するタイトルは、ユーザーが `options.title` を明示した場合だけとする。

### 10.3 著者

MVPでは次の優先順位とする。

1. `options.author`
2. 空文字

front matterからの著者抽出は行わない。

## 11. 章・目次情報

Markdown見出しから既存のXTC章メタデータを生成する。

選択規則:

1. 文書中に非空H1が1つ以上あれば、すべての非空H1を章とする
2. H1がなければ、すべての非空H2を章とする
3. H1/H2がなければ章なし
4. H3以下は章にしない

各章見出しの直前へ、既存のXTC章マーカーを挿入する。

既存の以下を再利用すること。

- `XtcChapter`
- マーカー形式
- マーカー採番
- マーカーHTML
- マーカーCSS
- 章名の正規化
- Container側の最大200章制限

現在 `packages/aozora-text/src/chapters.ts` にある汎用的な章ヘルパーを再利用する。必要なものがpackage indexからexportされていなければexportを追加する。マーカー形式をMarkdown用に独自実装しない。

見出し例:

```md
# はじめに

# 設計

# 実装
```

結果例:

```ts
[
  { name: "はじめに", marker: "XTCCH0001" },
  { name: "設計", marker: "XTCCH0002" },
  { name: "実装", marker: "XTCCH0003" },
]
```

見出し名はMarkdown装飾を除いたプレーンテキストにする。

```md
# **重要な** 設計 `v2`
```

章名:

```text
重要な 設計 v2
```

## 12. `prepareTextDocument()` の変更

`src/text-prepare.ts` に `prepareMarkdown()` を追加する。

概念フロー:

```ts
function prepareMarkdown(input: PrepareTextDocumentInput): PreparedTextDocument {
  const normalized = normalizeMarkdownSource(input.decodedText);
  const parsed = markdownConverter.parse(normalized.text);

  const explicitTitle = input.options.title.trim();
  const documentTitle =
    explicitTitle ||
    parsed.firstH1 ||
    resolveDocumentTitle("", input.filename);

  const contentHtml = buildMarkdownContentHtml(parsed.contentHtml);

  const html = buildTextDocumentShell({
    contentHtml,
    options: input.options,
    documentTitle,
    displayTitle: explicitTitle,
    author: input.options.author.trim(),
  });

  return {
    html,
    documentTitle,
    author: input.options.author.trim(),
    searchableText: parsed.plainText,
    characterCount: codePointLength(normalized.text),
    lineCount: lineCountOf(normalized.text),
    controlCharsRemoved: normalized.controlCharsRemoved,
    chapters: parsed.chapters,
    chapterHeadingLevel: parsed.chapterHeadingLevel,
    diagnostics: EMPTY_DIAGNOSTICS,
  };
}
```

最終分岐は明示的な `switch` にする。

```ts
export function prepareTextDocument(input: PrepareTextDocumentInput): PreparedTextDocument {
  switch (input.options.inputFormat) {
    case "aozora":
      return prepareAozora(input);
    case "markdown":
      return prepareMarkdown(input);
    case "plain":
    default:
      return preparePlain(input);
  }
}
```

`default` は型安全性を損なわない形で実装する。過去データで `inputFormat` が欠けている場合のplain互換テストを維持する。

## 13. プレーンテキスト抽出

`plainText` はMarkdownソースをそのまま返さず、レンダリング対象のトークンから抽出する。

含めるもの:

- 通常テキスト
- 見出し文字列
- 強調・太字の中身
- リスト項目
- 引用本文
- インラインコード
- コードブロック本文
- リンクラベル
- autolinkの表示URL
- 画像の代替テキスト

除外するもの:

- `#`、`**`、バッククォートなどの構文記号
- リンク先URL。ただしURL自体が表示ラベルなら含める
- 画像URL
- 章マーカー文字列
- HTMLタグ記号

用途:

- 空本文判定
- フォントサブセット文字列
- 将来の検索用文字列

## 14. 複雑度・サイズ制限

既存制限を維持する。

- アップロード: 5 MiB
- 文字数: 2,000,000
- 行数: 200,000
- 1行: 100,000文字
- 生成HTML: 12 MiB

追加制限:

```text
Markdown token数: 500,000以下
Markdown nesting: 50以下
```

token数超過時は決定的エラーとして扱い、Workflowの再試行対象にしない。

新しい例外:

```ts
class MarkdownComplexityLimitError extends Error
```

クライアントへ本文、見出し、URL、コード内容などを含むエラー文字列を返さない。

推奨メッセージ:

```text
Markdown document is too complex to convert
```

フロントエンドのエラーマッピングを追加する。

## 15. Markdown用CSS

`MARKDOWN_DOCUMENT_CSS` を共有パッケージに置き、本番HTMLとフロントエンド本文プレビューで共有する。

最低限必要な対象:

- `h1`〜`h6`
- `p`
- `ul`、`ol`、`li`
- `blockquote`
- `code`
- `pre`
- `hr`
- `table`、`thead`、`tbody`、`tr`、`th`、`td`
- `.md-link`
- `.md-image-placeholder`
- `.xtc-chapter-marker`

設計原則:

- 物理方向ではなく論理プロパティを優先
- 白黒・1-bit表示で判別できる
- 背景色だけに意味を依存させない
- 見出し直後で不自然に改ページしにくくする
- リスト記号を保持する
- 引用は線とインデントで区別する
- テーブルは罫線を表示する
- コードは等幅フォントを使う
- 長いコード・URLはページ幅内で折り返す
- 外部CSSを参照しない

概念例:

```css
.content h1,
.content h2,
.content h3,
.content h4,
.content h5,
.content h6 {
  break-after: avoid;
  margin-block-start: 1.2em;
  margin-block-end: 0.55em;
  line-height: 1.35;
}

.content blockquote {
  margin-inline: 1em 0;
  padding-inline-start: 0.8em;
  border-inline-start: 2px solid currentColor;
}

.content pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid currentColor;
  padding: 0.6em;
  break-inside: auto;
}

.content table {
  border-collapse: collapse;
  max-inline-size: 100%;
}

.content th,
.content td {
  border: 1px solid currentColor;
  padding: 0.25em 0.4em;
  overflow-wrap: anywhere;
}
```

### 15.1 縦書き

Markdown本文全体は既存のルート `writing-mode: vertical-rl` に従う。

以下は読みやすさのため横組みブロックとして扱ってよい。

- fenced code block
- indented code block
- table

ただし、Chromiumの印刷ページ分割で、入れ子の `writing-mode` が巨大ブロックを分割できず白紙ページを発生させる既知リスクがある。実装時は以下を守る。

- `break-inside: avoid` を無条件に付けない
- 長いコードブロックは折り返し・分割可能にする
- 1ページを超えるテーブル・コードの縦書きテストを行う
- Cloudflare Browser Rendering相当の実環境で確認する
- 問題が再現する場合は、MVPでは横組み強制を撤回し、縦書きの流れに従わせる

## 16. CSP・セキュリティ

生成HTMLの既存CSPを維持する。

```text
default-src 'none'; style-src 'unsafe-inline'; font-src data:;
```

Markdown分岐でネットワークアクセスを増やさない。

禁止事項:

- `<script>`
- `<style>` のユーザー入力
- `<iframe>`
- `<object>`
- `<embed>`
- `<img>`
- `<video>`
- `<audio>`
- `<source>`
- `<link>`
- 任意の `href`
- 任意の `src`
- `style` 属性
- `class` のユーザー指定
- `id` のユーザー指定
- `on*` イベント属性
- `data-*` のユーザー指定

Markdownレンダラーは許可リスト方式にする。最終HTML断片に含めてよいタグをテストで固定する。

推奨許可タグ:

```text
p h1 h2 h3 h4 h5 h6
em strong s
ul ol li
blockquote
code pre
hr br
table thead tbody tr th td
span
```

許可属性:

- `ol[start]` の安全な整数値
- 固定クラスのみ
- 章マーカー用の固定 `aria-hidden="true"`
- テーブル見出しの固定 `scope` を使う場合のみ

ユーザー入力から任意の属性名・属性値をコピーしない。

## 17. フロントエンド

### 17.1 ファイル受付

変更対象:

- `frontend/src/lib/input-file-kind.ts`
- `frontend/src/lib/text-file-validate.ts`
- `frontend/src/components/FileDropZone.svelte`
- 関連テスト

`accept`:

```text
text/plain,text/markdown,.txt,.md,.markdown,application/pdf,.pdf,application/epub+zip,.epub
```

### 17.2 入力形式UI

`TextOptions.svelte` のセグメントへMarkdownを追加する。

```text
プレーンテキスト | Markdown | 青空文庫
```

i18nキー例:

```ts
text_input_format_markdown
text_input_format_markdown_hint
text_join_lines_markdown_note
text_markdown_parsed_note
```

日本語表示例:

- ラベル: `Markdown`
- ヒント: `見出し・リスト・引用・コード・表などを解釈します。HTMLや画像は読み込みません。`

英語表示も追加する。

### 17.3 Markdown時に無効化する設定

以下をdisabled表示にする。

- 連続空行の上限
- 空白の保持
- 行の自動連結

説明文:

```text
Markdownでは改行・空白・インデントが構文に使われるため、この設定は適用されません。
```

レイアウト、フォント、文字サイズ、行間、段落間隔、余白、文字揃え、ページ番号、表題、著者は利用可能とする。

### 17.4 バッジ

ファイル名が `.md` または `.markdown` のとき、添付バッジを `MD` にする。`.txt` を手動でMarkdown指定した場合は、ファイル種別バッジは `TXT` のままでよい。

### 17.5 本文プレビュー

`TextInputPanel.svelte` の本文プレビューへMarkdown分岐を追加する。

- 共有Markdownパーサーを使用
- 共有 `MARKDOWN_DOCUMENT_CSS` を使用
- 生入力をそのまま `{@html}` へ渡さない
- 共有レンダラーの許可リストHTMLだけを `{@html}` へ渡す
- 章マーカーは画面上でも選択・読み上げされない既存CSS/属性を使う
- 画像はプレースホルダー
- リンクはクリック不可

### 17.6 X3プレビュー

`POST /preview/text` をそのまま利用する。

本番とプレビューの両方が `prepareTextDocument()` のMarkdown分岐を通ること。別のサーバー側Markdownレンダラーを作らない。

## 18. X3プレビュー用本文切り出し

`frontend/src/lib/text-preview.ts` にMarkdown専用の切り出しを追加する。

基本:

- 目標800コードポイント
- 最大1,000コードポイント
- 段落境界を優先
- 見つからなければ行末を優先
- サロゲートペアを分断しない
- サーバー上限4,000コードポイント、32 KiBを守る

fenced code blockへの対応:

1. 切り出し位置がfence内なら、閉じfenceを最大4,000コードポイントまで探索する
2. 閉じfenceが見つかればそこまで延長する
3. 見つからなければ、開きfenceの直前まで戻す
4. fence文字はバッククォートとチルダの両方に対応
5. fence長を考慮し、同じ種類・同等以上の長さの閉じfenceだけを閉じとみなす

Markdownの切り出しは構文上安全な境界を優先するが、セキュリティ境界ではない。サーバーは既存どおりサイズとoptionsを再検証する。

## 19. バックエンド変更箇所

### 必須

| ファイル | 変更 |
|---|---|
| `src/text-options.ts` | `markdown`追加、validation更新 |
| `src/text-prepare.ts` | `prepareMarkdown()`追加、switch分岐 |
| `src/text-html.ts` | Markdown安全HTMLとCSSの組み込み、拡張子処理 |
| `src/text-upload.ts` | `text/markdown`許可、コメント更新 |
| `src/workflow.ts` | Markdown複雑度エラー処理、ログ項目 |
| `src/preview/text-preview.ts` | Markdown例外の決定的エラー処理 |
| `packages/markdown-text/src/*` | 共有Markdown変換 |
| `package.json` / `package-lock.json` | `markdown-it`固定依存 |
| `README.md` | API・対応構文・制限を更新 |

### 原則不要

- `src/pdf.ts`
- `src/container.ts`
- `converter/`
- `xtctool`
- R2キー構造
- Workflowのステップ構成
- XTC保存処理
- レート制限
- 認証
- D1
- EPUB変換

ただしMarkdown見出しの章情報は、既存 `convertInContainer(..., chapters)` を通して送る。

## 20. ログ・観測

既存ログへMarkdown情報を追加する。

例:

```text
[jobId] text: inputFormat=markdown chars=12345 lines=420 tokenCount=980 chapterHeadingLevel=1 chapterCount=12
```

ログへ出してよいもの:

- inputFormat
- 文字数
- 行数
- token数
- 章レベル
- 章数
- 制御文字除去数
- 生成HTMLバイト数
- 処理時間

ログへ出してはいけないもの:

- 本文
- 見出し名
- タイトル
- 著者
- URL
- コードブロック内容
- 画像パス
- リンク先

`PreparedTextDocument.diagnostics` はMVPではMarkdown時にゼロでよい。Markdown専用にtoken数を返すフィールドを増やす場合は、plain/aozoraの既存戻り値との互換を保つ。

## 21. エラー

Markdown固有エラーを決定的エラーとして扱う。

| 条件 | 結果 |
|---|---|
| token数超過 | failed、再試行なし |
| nesting超過 | failed、再試行なし |
| 生成HTML上限超過 | 既存のtoo long |
| 空本文 | 既存のempty判定 |
| パーサー内部例外 | failed、再試行なし |
| Browser Rendering失敗 | 既存どおり |
| Container失敗 | 既存どおり |

パーサー内部例外時も、入力内容をエラー文字列へ連結しない。

## 22. テスト仕様

### 22.1 `TextInputFormat`

- `"markdown"` を受理する
- 省略時は `"plain"`
- `"md"`、`"commonmark"` など未知値は拒否
- plain/aozora既存テストが通る
- frontend validatorも同じ結果

### 22.2 Markdown構文

最低限以下をテストする。

- ATX H1〜H6
- Setext H1/H2
- 段落
- 太字・斜体・取り消し線
- 順序付き・順序なし・入れ子リスト
- 引用
- inline code
- fenced code
- indented code
- horizontal rule
- table
- hard break
- Markdown link
- autolink
- image placeholder
- 日本語
- 絵文字・サロゲートペア
- CRLF

### 22.3 セキュリティ

入力:

```md
<script>alert(1)</script>
<style>body{display:none}</style>
<iframe src="https://example.com"></iframe>
<img src=x onerror=alert(1)>
[危険](javascript:alert(1))
![画像](https://example.com/a.png)
```

検証:

- 生の `<script>` がない
- 生の `<style>` がない
- `<iframe>` がない
- `<img>` がない
- `href=` がない
- `src=` がない
- `onerror=` がない
- `javascript:` が属性としてない
- 外部fetchが呼ばれない
- 入力文字列は必要に応じて安全な文字として表示される

### 22.4 タイトル

- 明示 `options.title` が最優先
- title空 + H1ありでH1
- H1内の装飾を除去
- H1なしで `.md` ファイル名
- `.markdown` を正しく除去
- 空ファイル名で `Untitled`
- H1由来タイトルを本文ヘッダーへ重複挿入しない
- 明示タイトルは本文ヘッダーへ表示

### 22.5 章

- H1があればH1だけ
- H1がなければH2
- H3だけなら章なし
- 空見出しは除外
- 装飾を除いた章名
- markerが見出し直前
- markerが既存形式
- `chapters` とHTML markerの数・順序が一致
- 200超は既存Container入口で切り詰められる
- previewでも同じmarkerを生成

### 22.6 正規化

- fenced codeのインデントを保持
- indented codeの4空白を保持
- hard breakの末尾2空白を保持
- リストのインデントを保持
- 空行を勝手に圧縮しない
- `joinHardWrappedLines` のtrue/falseで出力が変わらない
- `maxConsecutiveBlankLines` で出力が変わらない
- `preserveSpaces` でMarkdown全体がpre-wrapにならない
- CRLFのみLFへ統一

### 22.7 プレーンテキスト抽出

- 構文記号を含まない
- リンク先URLを含まない
- リンクラベルを含む
- 画像altを含む
- code本文を含む
- marker文字列を含まない
- 空白だけのMarkdownはemptyになる

### 22.8 フロントエンド

- `.md` をtextとして判定
- `.markdown` をtextとして判定
- `text/markdown` を許可
- PDF/EPUBを誤判定しない
- 拡張子自動選択
- MIME自動選択
- 手動選択優先
- 青空自動判定よりMarkdown拡張子を優先
- Markdownボタン・hint
- ignored optionsのdisabled表示
- 本文プレビューに安全HTML
- X3プレビューcache keyに `inputFormat: markdown` が反映
- fence途中で不正切断しない

### 22.9 回帰

以下の既存テストを維持する。

- plain出力のbyte-identical parity
- plainでMarkdownを文字どおり表示
- plainでHTMLをescape
- aozoraパーサー
- aozora診断
- aozora章抽出
- 本番とX3プレビューが同じ `prepareTextDocument()` を使う

## 23. 受け入れ基準

以下をすべて満たしたら完了とする。

1. WebUIで `.md` を選択できる
2. `.md` 選択時にMarkdownが自動選択される
3. `.txt` でも手動でMarkdownを選べる
4. 見出し・リスト・引用・コード・表がXTCで読める
5. 生HTMLが実行されない
6. 外部画像を取得しない
7. リンクがクリック可能な属性を持たない
8. 最初のH1がXTCタイトル候補になる
9. H1またはH2からXTC章情報が生成される
10. 本番とX3プレビューが同じ準備処理を使う
11. 縦書きで通常本文が読める
12. 縦書きの長いコード・表で白紙ページが発生しない
13. plainの既存HTML出力が変わらない
14. aozoraの既存HTML・章情報が変わらない
15. 既存APIの `inputFormat` 省略がplainのまま
16. 全テスト・型検査・フロントエンドビルドが成功する

## 24. 実装順序

### Phase 1: 契約とパーサー

1. `TextInputFormat` へ `markdown`
2. root/frontendへ同一固定版 `markdown-it`
3. `packages/markdown-text`
4. 安全レンダラー
5. plainText抽出
6. 見出し・章抽出
7. パーサー単体テスト

### Phase 2: バックエンド統合

1. Markdown正規化
2. `buildMarkdownContentHtml`
3. `prepareMarkdown`
4. タイトル解決
5. Workflowエラー・ログ
6. preview統合
7. API Content-Type
8. バックエンド統合テスト

### Phase 3: WebUI

1. `.md/.markdown`受付
2. 自動判定
3. 入力形式ボタン
4. ignored optionsのdisabled
5. Markdown本文プレビュー
6. X3プレビュー切り出し
7. i18n
8. frontendテスト

### Phase 4: 実環境確認

1. 横書きサンプル
2. 縦書きサンプル
3. 長いコード
4. 幅広テーブル
5. 100章以上
6. 200章超
7. Cloudflare Browser Rendering
8. Xteink X3実機または既存XTCプレビュー

## 25. 検証コマンド

実装後、少なくとも以下を実行する。

```bash
npm ci
npm test
npm run typecheck

npm ci --prefix frontend
npm run test --prefix frontend
npm run check:frontend
npm run build:frontend
```

必要に応じてConverter回帰も実行する。

```bash
npm run test:converter
```

依存解決確認として、クリーン環境でルートと `frontend/` を別々にinstallしてビルドすること。ローカルに残った親ディレクトリの `node_modules` に偶然依存していないことを確認する。

## 26. レビュー観点

- Markdownの構文精度より先に、HTML安全性を確認する
- raw HTMLが有効になっていないか
- リンク・画像属性が残っていないか
- ユーザー入力由来のclass/style/idがないか
- Markdown固有空白が正規化で壊れていないか
- 本番とpreviewの変換コードが分岐・重複していないか
- root/frontendの `markdown-it` バージョンが一致しているか
- chapter markerを独自実装していないか
- plainのbyte parityが保たれているか
- aozoraの章抽出が変化していないか
- 縦書きのcode/tableでChromium印刷が破綻しないか
- ログ・エラーへ本文が漏れていないか

## 27. 技術リスク

| リスク | 影響 | 対策 |
|---|---|---|
| Markdown構文用空白を既存normalizeが壊す | コード・リスト・改行が崩れる | 専用normalize |
| raw HTMLや属性の混入 | XSS・意図しない取得 | `html:false` + 独自allowlist renderer |
| backend/frontendの解釈差 | previewと本番の不一致 | 共有変換ロジック + 同一固定版 |
| 縦書き内のtable/code | 白紙・はみ出し | 実Browser Renderingテスト |
| 大規模Markdown | CPU・メモリ負荷 | 既存サイズ上限 + nesting/token上限 |
| 見出しmarkerの重複実装 | XTC目次不整合 | 既存chapter helper再利用 |
| 依存解決がローカル環境だけ成功 | deploy失敗 | root/frontendを個別にclean install |

## 28. 完了時のドキュメント更新

READMEの以下を更新する。

- WebUIの対応ファイル: PDF / TXT / Markdown / EPUB
- `POST /jobs/text`
- `inputFormat: "plain" | "aozora" | "markdown"`
- Markdown対応構文
- 生HTML・リンク・画像の扱い
- Markdownでは無視されるオプション
- Markdownの章抽出規則
- 既知の制限
- MIMEと拡張子
- セキュリティ方針

既存の「Markdownは一切解釈しない」という説明は、`inputFormat: "plain"` に限定した説明へ書き換える。

---

## 実装エージェントへの最終指示

- 新しい変換経路を作らず、既存 `POST /jobs/text`、Workflow、PDF、Container、XTC変換を再利用すること
- `plain` と `aozora` の回帰を最優先すること
- Markdown本文を任意HTMLへ変換してから汎用サニタイザーへ通す設計ではなく、最初から許可リストのHTMLだけを生成すること
- backendとfrontendのMarkdown変換ロジックを複製しないこと
- 章マーカーを複製しないこと
- 実装完了前に、クリーンinstall、型検査、全テスト、frontend build、縦書きPDF/XTC確認を行うこと
