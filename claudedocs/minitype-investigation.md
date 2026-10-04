# minitype 調査メモ（2026-09-14）

対象: [TypeScript ライブラリとして動作する組版エンジン minitype を公開しました（Zenn）](https://zenn.dev/inaniwaudon/articles/62f1def4bad627) / <https://typeset.jp/>

## 結論

- **現行パイプラインの全面置換には使えない。** minitype の入力は TypeScript のオブジェクト（`h1()` / `p()` / `ruby()` など）で、HTML/CSS を読まない。URL・EPUB 経路は引き続き Chrome が要る。
- **TXT / 青空文庫の縦書きに限れば、明確な優位がある。** 組版品質（ルビ掛け・行の均等配置・ぶら下がり）、見出しのページ番号を直接取れること、Chrome 起因のワークアラウンドが不要になること、の3点。
- **ただし今すぐ組み込むのは勧めない。** 先に解決が要るのは (1) ライセンス（コアは PolyForm Noncommercial 1.0.0）、(2) 成熟度（v0.1.6、実際にバグを踏んだ）、(3) Workers では動かず、Node 入りコンテナと 1GiB 超のメモリが要ること。
- 検討を進めるなら、まず作者にライセンスを確認する。そのうえで「TXT（aozora/markdown）縦書き限定のオプトイン実験エンジン」として PoC する、という順番が妥当。

## minitype の概要（2026-09-14 時点で確認した事実）

| 項目 | 内容 |
|---|---|
| パッケージ | `@minitype/minitype` 0.1.6（npm 最終更新 2026-09-04）。未踏アドバンスト 2025 年度下期の成果物 |
| ライセンス | コアは PolyForm Noncommercial 1.0.0。記事によると、個人・同人利用は自由で、商用利用は要問い合わせ。`create-minitype` と `@minitype/vite-plugin` は MIT |
| 入力 | TS オブジェクト / 関数、JSX（`@minitype/tsx`）、Markdown プラグイン（`md` / `mdString`）。**HTML/CSS 入力はない** |
| 出力 | `toPdf()`（PDFKit / pdf-lib）、`toImages()`（PDF を pdf.js + `@napi-rs/canvas` でラスタライズした PNG）、`getLayout()`（ブロックごとの pageIndex と座標）、`getPageCount()`、`getDiagnostics()` |
| 組版機能 | jlreq と Knuth–Plass がベース。縦組、ルビ（`rubyAlign: center / jis / justify`）、禁則（追出し・追込み・ぶら下がり）、縦中横、合成フォント、文字組アキ量、圏点プラグイン（`kenten`）、段組、フロート、PDF しおり |
| 実行環境 | Node.js / Bun / ブラウザ。Node 版は native モジュール（`@napi-rs/canvas`、`better-sqlite3`）に依存する。`npm install` 後の node_modules は 261MB。ブラウザ版 `index.browser.js` は単体で 9MB |
| フォント | `fontDir` から `.otf` / `.ttf` / `.ttc` を読む。**既定スタイルが `SourceHanSerifJP-Regular` / `-Bold` を参照するため、そのファイル名が無いと例外で落ちる** |

## ローカル検証

### 条件

- 素材: 青空文庫『羅生門』（7,111 字）と『坊っちゃん』（105,100 字）
- ページ: X4 相当（480×800px）、本文 24px、縦書き
- minitype 側: Noto Serif JP（OTF）を `SourceHanSerifJP-*` の名前でエイリアスして使用。余白 6mm、行送り 1.75em。ルビ（`｜` / `《》`）と見出し注記だけを自前の正規表現で変換した
- 現行側: 本番と同じ `prepareTextDocument`（inputFormat: aozora、layout: vertical、device: x4、BIZ UDMincho）と `buildInlineFontCss` で HTML を作り、ローカル Chrome で print-to-PDF した
- 実行環境はローカル Mac の Node 26。本番の Browser Rendering やコンテナとは速度が違う

### 結果

| | minitype 羅生門 | minitype 坊っちゃん | 現行 羅生門 | 現行 坊っちゃん |
|---|---|---|---|---|
| ページ数 | 21 | 311 | 25 | 358 |
| 組版 | 0.34s | 1.33s | — | — |
| PDF 生成 | 0.92s | 15.2s | 1.3s（Chrome 全体） | 1.8s（Chrome 全体） |
| PNG 全ページ（480×800） | 1.73s | 24.5s | — | — |
| PDF サイズ | 3.2MB | **53.5MB** | 306KB | 3.1MB |
| peak RSS | 1.1〜1.3GiB | 1.35〜1.44GiB | — | — |
| 診断 | 19 件 | 153 件 | — | — |

注意:

- **ページ数は比較できない。** フォント・余白・行送り・段落間隔がそろっていないため。
- **速度も単純比較できない。** 「Chrome のほうが 8 倍速い」とは読まないこと。ローカル Chrome は速いが、本番の Browser Rendering は quickAction の 60 秒付近でタイムアウトし、長編では 4 分割フォールバックに入る（`src/workflow.ts:116-181`、`src/pdf.ts:744-803`）。コンテナで minitype を動かす場合、ブラウザ側の時間予算という制約自体がなくなる。
- 診断は、行が 3.3mm ほどはみ出すという `overfull-line` の警告だった。句読点のぶら下がりに相当する量で、実害は見られない。組版の問題を機械的に検出できること自体は Chrome に対する利点になる。

### 見た目（1bit 化前の 480×800 画像で比較）

- ルビ: 羅生門の「円柱《まるばしら》」で差が出た。Chrome は親文字を割って「円　柱」と間を空けた。minitype は前後のかなにルビを掛けて親文字を詰めたまま組んだ。minitype のほうが自然。
- 禁則・句読点: どちらも破綻はない。minitype は行末の句読点をぶら下げ、行長もそろっている。
- **1bit ディザ後に差がどれだけ残るかは未検証。**

### その他の実測

- `toImages()` は `ppi: 96` を指定すると **ちょうど 480×800 の PNG**（RGBA 8bit）を出す。デバイス解像度で直接ラスタが得られるので、PDF → PyMuPDF 200dpi → 縮小という段を丸ごと省ける。
- `getLayout()` で見出しのページ番号が直接取れた。坊っちゃんでは「一」〜「十一」がそれぞれ 0, 25, 45, 65, 90, 116, 152, 188, 215, 245, 273 ページ目（0 ページ目には表題「坊っちゃん」と「一」が並ぶ）。
- minitype の PDF は **文字がアウトライン化されていてテキスト層がない**（`pdffonts` は空、`pdftotext` はほぼ 0 文字）。そのため:
  - 現行の章マーカー方式（PDF テキスト層の文字列検索、`converter/app.py:385-475`）は使えない
  - 坊っちゃんの PDF は 53.5MB で、`MAX_PDF_BYTES`（48MiB、`wrangler.jsonc:16`）を超える
- 0.1.6 のバグ: 同じインスタンスで `toPdf()` のあとに `toImages()` を呼ぶと、`better-sqlite3` の "The database connection is not open" で落ちる。別インスタンスにすれば回避できる。

## 現行との比較

| 観点 | 現行（Browser Rendering の Chrome + xtctool） | minitype |
|---|---|---|
| 入力 | URL / 青空文庫 URL / TXT / EPUB / PDF | TS オブジェクト。TXT・青空文庫・Markdown は既存の AST（`packages/aozora-text`、`packages/markdown-text`）から変換できる見込み。HTML / EPUB は変換器を自作することになり、著者 CSS はほぼ失われる |
| 縦書きの品質 | Chrome の CSS 組版に依存 | jlreq 準拠。ルビ掛け・ぶら下がり・行の均等配置が効く |
| 章目次 | 白色 1px のマーカーを埋め込み、コンテナで PDF テキスト層を検索 | `getLayout()` が見出しの pageIndex を返す |
| 実行場所 | Worker → Browser Rendering → Container | Node 入りのコンテナ。native 依存があり、RSS も 1GiB を超えるため Workers では動かない |
| 時間の制約 | quickAction の 60 秒付近 + 4 分割フォールバック | ブラウザの予算はない（コンテナのタイムアウトだけ） |
| フォント | Google Fonts の woff2 サブセットを data URL で埋め込む（3,600 字上限、`src/fonts.ts:108-121`） | OTF / TTF ファイルが要る。今のように任意の Google Fonts ファミリーを選べる機能を残すなら、フォントファイルを取得する仕組みが別途要る |
| メモリ | 80 ページのチャンク変換を 2 並行で peak 約 694MiB（`wrangler.jsonc` のコメント） | 1 件あたり 1.1〜1.4GiB（ローカル実測）。standard-1（4GiB）なら既存の変換とも同居できそうだが、`max_instances: 4` での並行度には影響する |
| ライセンス | 本体は AGPL-3.0 | PolyForm Noncommercial 1.0.0 |

### minitype で不要になる Chrome 起因のワークアラウンド（TXT / 青空文庫経路に限る）

- 縦書きの orphans/widows で 1 列丸ごと空くページ（`src/text-html.ts:130-204`）
- `writing-mode` をルート要素にしか付けられない制約（`src/pdf.ts:336-337`）
- `@media print` 内の `font-family` で遅延フォントが読まれない問題（`src/pdf.ts:222-231`）
- 章マーカーまわりの一式: alpha=0 のテキストが消える、色が各チャネル −84 される、匿名ブロックでページがずれる（`packages/aozora-text/src/chapters.ts:82-232`）
- 縦書き印刷で余白が片側に寄る問題
- quickAction のタイムアウトと、青空文庫の 4 分割フォールバック（`src/aozora-fallback/`）
- フォントサブセットの字数上限

URL・EPUB 経路はどれも Chrome のまま残る。つまり組版エンジンが 2 系統になり、保守の負担が増える。

## ブロッカー

1. **ライセンス**: コアの PolyForm Noncommercial は非商用に限る。本体は AGPL-3.0 で公開サービスとして動いており、AGPL は第三者への追加制限を禁じている。組み合わせてよいのか、このサービスが「非商用」に当たるのかは、作者への確認とユーザーの判断が要る（ここでは法的判断はしていない）。
2. **HTML / EPUB を入力できない**: TXT 系しか置き換えられない。
3. **成熟度**: 0.1.6 で公開から約 10 日。`toPdf` → `toImages` のクラッシュ、既定フォント名が無いと落ちる挙動を今回実際に踏んだ。
4. **実行環境**: 今の converter イメージは Python なので、Node と native モジュールと OTF の同梱が要る。
5. **PDF 経由の統合**: 53MB 級の PDF になり、テキスト層もない。既存のコンテナにそのまま流す案は筋が悪い。

## 組み込む場合の案（PoC の範囲）

1. 作者にライセンスを確認する（AGPL で公開しているサービスに組み込んでよいか）
2. 範囲を TXT（aozora / markdown）の縦書きに絞り、オプトインにする
3. converter コンテナに Node と `@minitype/minitype` と OTF / TTF フォント（BIZ UDMincho など）を入れる
4. `packages/aozora-text` の AST を minitype のブロックに変換する（字下げ・圏点・改ページ・見出し）
5. `toImages()`（X4 は 480×800、X3 は 528×792）→ 1bit ディザ → XTG / XTC にパックする。xtctool が画像入力を受け付けるかは未確認
6. `getLayout()` の見出し pageIndex を、章メタデータとして直接渡す

PoC で確かめること: 1bit 化したあとの見え方、BIZ UDMincho の TTF で動くか、1,000 ページ級での時間とメモリ、コンテナ内での速度。

## 調査の副産物

TXT（aozora）経路で、行頭に字下げ注記が付いた同行見出し（例: `［＃５字下げ］一［＃「一」は中見出し］`）を見出しとして認識せず、章が 0 件になる。坊っちゃんの TXT で確認し、合成テキストで原因を切り分けた。字下げが無い形と「ここから中見出し」形式なら認識される。修正は別タスクに切り出した。
