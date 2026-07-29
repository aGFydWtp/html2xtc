# 画像込み青空文庫入力対応 実装仕様書

## 1. 文書情報

- 対象リポジトリ: `aGFydWtp/html2xtc`
- 推奨ブランチ名: `feature/aozora-image`
- 対象: 青空文庫形式テキスト（`inputFormat: "aozora"`）における挿絵・キャプション対応
- 仕様バージョン: 2
- 作成日: 2026-07-27
- 前提仕様: `html2xtc-markdown-conversion-spec.md`（入力形式追加の設計方針）、
  `EPUB_TO_XTC_IMPLEMENTATION_SPEC.md`（ZIP・画像埋め込みの前例）

### 改訂履歴

- v1 → v2: レビュー指摘により、挿絵・キャプションを**ブロックノードからインライン
  ノードに変更**（§8 の設計根拠を参照）。CSP 変更を必須項目に格上げ。
  文字コードと CSS 注入の2件を「未確認事項」から確定事実に移動。

### この仕様書の位置づけ

設計判断の多くは上記2つの既存実装を踏襲する。独自の判断をしている箇所は
理由を本文に明記した。着手前に §21（未確認事項）を必ず潰すこと。

---

## 2. 結論

**実装可能。** XTC フォーマット側に画像の概念がなく（ページ全体をラスタライズする）、
画像込みアップロードの前例が EPUB 経路に既にあるため、構造的な障壁はない。

作業は2段階に分ける。

| Stage | 内容 | 依存 | 効果 |
|---|---|---|---|
| **A** | 挿絵・キャプション注記のパーサー対応（画像は代替テキストのプレースホルダー） | なし | 現状「生の注記文字列が本文に混ざる」問題が解消する |
| **B** | ZIP入力を受け付け、実画像を data URL として埋め込む | Stage A | 挿絵が実際に XTC に載る |

Stage A だけでも単独で価値があり、Stage B は画像の解決先を差し替えるだけで済む構造にする。

---

## 3. 背景

### 3.1 「青空文庫」の入口は2つある

| 経路 | エンドポイント | 挿絵の現状 |
|---|---|---|
| URL入力（aozora.gr.jp の XHTML 版） | `POST /convert`（`src/index.ts:158`） | **すでに動く**。公開 XHTML の `<img class="illustration">` を Chromium がそのままレンダリングし、専用 CSS が `packages/aozora-text/src/styles.ts:74-82` にある |
| テキストアップロード | `POST /jobs/text` + `inputFormat: "aozora"`（`src/index.ts:210`） | **未対応**。挿絵注記はパーサーの対応表になく、`packages/aozora-text/src/parse-inline.ts:395-401` の fail-soft により `rawAnnotation` として**本文に生の注記文字列がそのまま表示される** |

本書が扱うのは後者。

### 3.2 XTC 側に画像の概念はない

`converter/pdf_upload.py:531` が PDF の各ページを `page.get_pixmap()` でグレースケール
ラスタライズし、PNG 経由で `xtctool` に渡している。「画像かテキストか」は XTC に到達する
前に消える。したがって **`converter/` と `xtctool` の変更は不要**。

判断基準は「その画像が PDF のページ上に描画されているか」だけになる。

### 3.3 前例

- ZIP の安全な展開: `extractEpubArchive()`（`src/epub/archive.ts:230`）が
  central directory を inflate 前に検証する実装を持つ。EPUB 固有の処理は
  `validateEpubMimetype()` として分離されており、この関数自体は汎用。
- 画像の data URL 埋め込み: `rasterImageDataUrl()`（`src/epub/assets.ts:69-74`）。
- ZIP アップロードのマジックバイト先読み: `peekLeadingBytes()` + `hasEpubZipMagic()`
  + `FixedLengthStream` によるストリーム再構成（`src/index.ts:673-694`）。

---

## 4. 目的

1. 挿絵注記・キャプション注記を認識し、生の注記文字列が本文に出る現状を解消する。
2. 青空文庫の配布 ZIP（テキスト＋挿絵 PNG）をアップロード入力として受け付ける。
3. 挿絵を含む作品が、縦書きレイアウトを壊さずに XTC 化できる状態にする。

---

## 5. 非目標

- 挿絵の**外部 URL 取得**（ネットワークフェッチ）。埋め込みは ZIP 内の実ファイルのみ。
- 画像の**リサイズ・再エンコード・減色**。Worker 側では一切加工せず、
  グレースケール化は既存どおり converter に委ねる。
- **外字 PNG**（`img.gaiji`）のテキスト経路対応。外字は現状どおり
  Unicode 解決 → `.gaiji-fallback`（〓）の経路を維持する。
- 表（`［＃表］`）・図表の構造化。
- URL 入力経路（`src/aozora.ts`）の挙動変更。既に動いているものに手を入れない。
- 青空文庫以外の ZIP（任意のテキスト＋画像アーカイブ）の汎用サポート。
- **既存の単独行制御注記（改ページ・字下げ等）のチャンク境界問題の修正**（§21-1）。
  本仕様の挿絵実装はこの問題を回避する設計になっているが、既存注記側は触らない。

---

## 6. 基本設計

### 6.1 段階分割

**Stage A（パーサー）**: 挿絵注記を AST のインラインノードとして認識する。
このとき画像バイトはまだ存在しないので、レンダラはプレースホルダーを出す。
Markdown の `renderImagePlaceholder()`（`packages/markdown-text/src/renderer.ts:106-109`）
と同じ設計方針。

**Stage B（ZIP入力）**: アップロードが ZIP の場合に展開し、注記のファイル名を
ZIP エントリに解決して data URL に置き換える。画像解決は関数注入で行い、
Stage A のパーサーとレンダラは ZIP の存在を知らない。

### 6.2 新エンドポイントは作らない

既存 `POST /jobs/text` が ZIP も受け付ける形にする。Markdown 対応（同仕様書 §5.2 の
「新エンドポイントは作らない」）と同じ判断。理由:

- ジョブ管理・ステータス取得・ライブラリ保存の経路が既に共通である。
- フロントエンドの `InputFileKind` 判定に `"text"` の枝が既にあり、拡張が小さい。
- `inputFormat: "aozora"` という指定は ZIP でも単一テキストでも同一である。

判別は **Content-Type ではなくマジックバイト**で行う。Content-Type は
`application/zip` を許可リストに追加するが、判定の根拠にはしない
（`application/octet-stream` で送られてくる経路が既にあるため）。

**実装コストの注意**: 現行の `handleCreateTextJob`（`src/index.ts:584`）は
`request.body` をそのまま `saveUploadedText()` に渡しており、先読みの仕組みがない。
EPUB 経路（`src/index.ts:673-694`）が持つ「`peekLeadingBytes()` で先頭4バイトを読む →
`FixedLengthStream(declaredSize)` で残りストリームを包み直す → R2 保存」という
配線をテキスト経路にも新規に追加する必要がある。§15 の変更箇所に含めた。

**ZIP を受け付けるのは `inputFormat: "aozora"` のときのみ。** `plain` / `markdown`
で ZIP が来た場合は 400 で拒否する（暗黙に aozora へ昇格させない）。

### 6.3 API

`POST /jobs/text` の契約は変えない。

- `X-Text-Options`（base64url 化した UTF-8 JSON、`src/text-options.ts:253-268`）: 変更なし。
- Content-Type 許可リストに `application/zip` を追加
  （`ALLOWED_TEXT_CONTENT_TYPES`、`src/text-upload.ts:32`）。
- レスポンスは既存どおり 202 `{jobId, statusUrl}`。

### 6.4 ファイル拡張子・自動判定

フロントエンド（`frontend/src/lib/input-file-kind.ts:7-26`）:

- `.zip` を `InputFileKind = "text"` に加える。
- `application/zip` / `application/x-zip-compressed` を MIME 判定に加える。
- ZIP を選んだ場合、入力形式は `aozora` に固定し、UI 上で他形式を選べなくする。

自動判定（`packages/aozora-text/src/detect.ts` の `detectAozoraFormat`）は
テキスト内容のスコアリングなので、ZIP には適用しない。ZIP は無条件で aozora。

---

## 7. 青空文庫の画像注記仕様

出典: 青空文庫 注記一覧「画像とキャプション」
（https://www.aozora.gr.jp/annotation/graphics.html）。

### 7.1 画像注記

```
［＃コンドル博士の図（fig47728_06.png、横320×縦322）入る］
```

公式の XHTML 変換結果（**前後の本文と同じ段落内に、`<br />` で挟んで置かれる**）:

```html
…成るものである。<br />
<img class="illustration" width="320" height="322" src="fig47728_06.png" alt="コンドル博士の図" /><br />
　――その後はどうなつたらうか。…
```

旧記法（サイズ指定なし。既存収録作品に残っている）:

```
［＃石鏃二つの図（fig42154_01.png）入る］
```

キャプション付きの図:

```
［＃「第一七圖　國頭郡今歸仁村今泊阿應理惠按司勾玉」のキャプション付きの図（fig4990_07.png、横564×縦424）入る］
```

このとき `alt` には `「…」のキャプション付きの図` が丸ごと入る（公式の変換結果に準拠）。

**注記本体の構造**:

| 部位 | 内容 | 必須 |
|---|---|---|
| 説明 | 「図」「地図」「絵」「挿絵」「表」「写真」等で終わる説明文。`alt` になる | 必須 |
| ファイル名 | `fig{作品ID}_{通し番号}.png` 形式（2桁ゼロ埋め、100以上は3桁） | 必須 |
| サイズ | `横{w}×縦{h}`。`×` は全角（U+00D7）。旧記法では省略される | 任意 |

### 7.2 キャプション注記

3系統ある。すべて画像注記の**直後の行**（空行を挟まない）に置かれる。

```
神戸港頭の袂別［＃「神戸港頭の袂別」はキャプション］          ← 後置型
［＃キャプション］アケビの果実［＃キャプション終わり］          ← 開始/終了型（同一行）
［＃ここからキャプション］…複数行…［＃ここでキャプション終わり］  ← 範囲型（複数行）
```

公式の変換結果は、後置型・開始/終了型が `<span class="caption">`、
範囲型が `<div class="caption">`。

公式ページに「キャプションは横組みで添えられることが多いが、横組み注記を併用する
必要はない」と明記されているため、**縦書き時もキャプションを横組みにはしない**。

---

## 8. AST 拡張

### 8.1 ブロックではなくインラインにする（設計根拠）

**v1 ではブロックノードとして `parse-document.ts` の `handleControlChunk()` に
足す設計にしていたが、これは機能しない。**

`splitIntoParagraphChunks()`（`packages/aozora-text/src/tokenize.ts:52-69`）は
`\n{2,}`（2連続以上の改行）でしかチャンクを分割せず、`handleControlChunk()` には
`chunk.trim()` が渡される（`parse-document.ts:305-306`）。既存の単独行制御注記は
`^…$`（`m` フラグなし）の正規表現でマッチしており、注記が空行で前後を挟まれて
単独チャンクになっていることが暗黙の前提になっている。

§7.1 の公式記入例のとおり、**挿絵注記は本文と単一改行で隣接する**。したがって
本文行と同じチャンクに入り、`^…$` にはマッチしない。ブロック実装は最頻出パターンで
素通りする。

一方インライン実装（`parse-inline.ts` の `handleAnnotation()`）なら:

- 本文と隣接していても、単独チャンクで来ても、**同じ実装で拾える**。
- 公式 XHTML 変換自体が `<br /><img /><br />` というインライン出力であり、
  段落を切っていない。出力構造も一致する。

よってインラインノードとして実装する。

### 8.2 新しいインラインノード

`AozoraInline`（`packages/aozora-text/src/types.ts:68-120`）に追加する。

```ts
export interface AozoraImageInline {
  type: "image";
  /** 注記の説明部。alt になる。例: "コンドル博士の図" */
  description: string;
  /** 注記に書かれたファイル名（未解決の生の値）。例: "fig47728_06.png" */
  fileName: string;
  /** 注記のサイズ指定。旧記法では undefined */
  width?: number;
  height?: number;
}

export interface AozoraCaptionInline {
  type: "caption";
  children: AozoraInline[];
}
```

**キャプションは範囲型も含めてすべて `<span class="caption">` に統一する。**
公式は複数行キャプションを `<div>` にしているが、インライン実装では `<div>` を
出せない。複数行は `<br>` 区切りの単一 `span` にする。表示上の差は font-size と
改行のみで、判読性に影響しない。この逸脱は意図的。

### 8.3 影響箇所

新インライン種別を足したときに変更が必要な箇所。v1 の表はブロック前提で誤りが
複数あったため、インライン前提で洗い直した。

| ファイル | 関数 | 対応 |
|---|---|---|
| `packages/aozora-text/src/types.ts:68` | `AozoraInline` union | 追加 |
| `packages/aozora-text/src/parse-inline.ts:322-402` | `handleAnnotation()` | 検出分岐を追加（§9） |
| `packages/aozora-text/src/render-html.ts:65-108` | `renderInline()` | HTML 出力を追加（§10） |
| `packages/aozora-text/src/render-html.ts:388-409` | `extractPlainText()` の `visitInline` | 画像は `description`、キャプションは children を出す |
| `packages/aozora-text/src/render-html.ts:287-311` | `headingPlainText()` | 型網羅のため対応（実際には見出しに現れない） |
| `packages/aozora-text/src/count.ts:26-73` | `countInline()`（`countRecognizedAnnotations` の内部） | 認識注記として算入 |
| `packages/aozora-text/src/styles.ts` | CSS | `.caption` / `.aozora-image-placeholder` を追加（`img.illustration` は既存を流用） |

**変更不要と確認した箇所**（v1 で誤って挙げていたもの）:

- `parse-document.ts:97-102` の `countBlockNodes()` — `MAX_AST_NODES` 判定用。
  paragraph / heading 以外は `return 1` に落ちるため、そもそも変更不要。
  v1 は `count.ts:97` の関数と取り違えていた。
- `chapters.ts` — `block.type` を参照するコードが存在しない。章判定は
  `render-html.ts` の `determineChapterHeadingLevel()`（`:220-239`）と
  `extractChapters()`（`:349-368`）にあり、いずれも
  `if (block.type !== "heading") continue` の**除外方式**。新種別は自動的に
  無視されるため変更不要。
- `render-html.ts` の `visitBlock`（`:410-422`）— インライン実装なので無変更。

---

## 9. パーサー変更

### 9.1 検出位置

`handleAnnotation(rawBody: string): void`（`packages/aozora-text/src/parse-inline.ts:322-402`）
の直列 if チェーンに分岐を追加する。挿絵注記は外字注記（`:337-341`）と同じ
「前置型・対象文字列の後方参照なし」に分類される。

**分岐の順序**: 外字の正規表現 `/^「([^」]*)」(?:、\s*(.+))?$/` より**前**に置く。
外字パターンは `「…」` で始まる注記を広く拾うため、キャプション付きの図
（`「…」のキャプション付きの図（…）入る］`）が先に外字として誤判定されうる。

### 9.2 画像注記の正規表現

```ts
// {説明}（{ファイル名}[、横{w}×縦{h}]）入る
const IMAGE_RE = /^(.+)（([^（）、]+)(?:、横(\d+)×縦(\d+))?）入る$/;
```

`handleAnnotation` は `［＃` と `］` を剥がした `rawBody` を受け取るため、
正規表現に角括弧は含めない。

- ファイル名グループから `、` を除外した（v1 は `[^（）]+?` の non-greedy で
  バックトラックに依存していた）。青空文庫のファイル名は `fig{ID}_{連番}.png`
  形式で `、` を含まないため、この制限で取りこぼしは生じない。
- 説明部（第1グループ）は貪欲マッチ。説明に丸括弧が含まれても、末尾の
  `（…）入る` が先に固定されるため正しく分離される。
- `×` は全角のみ。半角 `x` は受け付けない（公式記法に従う）。

サイズが取れた場合のみ `width` / `height` を設定する。

### 9.3 キャプション注記

`handleAnnotation` に3系統の分岐を足す。**いずれも既存の後置注記・範囲注記の
枠組みにそのまま乗る。**

| 記法 | rawBody のパターン | 実装 |
|---|---|---|
| 後置型 | `「(.+)」はキャプション` | 既存の `applyPostConstruct()`（`:301-320`）に新しい construct として登録。直前のバッファから対象文字列を切り出す `wrapTrailingTarget()`（`:216-231`）がそのまま使える |
| 開始/終了型 | `キャプション` / `キャプション終わり` | 開始・終了が同一行に現れるが、既存の範囲注記スタック（`rangeStack`）で処理できる |
| 範囲型 | `ここからキャプション` / `ここでキャプション終わり` | 既存の `applyRangeStart()`（`:253-274`）/ `applyRangeEnd()`（`:276-299`）に kind を追加するだけ |

**後置型の誤爆の懸念について**: 既存の後置注記は
`/^「([^」]*)」に(.+)$/`（`:356-380`、助詞が「に」）と
`/^「([^」]*)」は縦中横$/`（`:383-393`）。キャプションは「は」＋固定文字列
「キャプション」なので、縦中横と同じ形。パターンが完全一致で衝突するのは
縦中横のみで、文字列が異なるため競合しない。

入れ子上限は既存の `MAX_RANGE_NESTING_DEPTH`（32、`types.ts:154`）に従う。
未閉じは既存どおり `unclosed-range` 診断。

### 9.4 診断

`AozoraDiagnostic["kind"]`（`packages/aozora-text/src/types.ts:129-134`。既存は
`unsupported-annotation` / `malformed-annotation` / `unmatched-end` / `unclosed-range` /
`ruby-without-base` / `resource-limit`）に1種類追加する。

```ts
| "unresolved-image"   // 挿絵注記は認識できたが、画像の実体が見つからない
```

Stage A では **常にこの診断が出る**（画像を持たないため）。異常ではなく期待動作
なので severity は `"warning"`。

- 注記の形が壊れている（ファイル名が空等）→ `malformed-annotation`
- 認識できたが実体がない → `unresolved-image`
- キャプションの範囲が閉じていない → `unclosed-range`（既存）

---

## 10. レンダラ変更

### 10.1 画像の解決を関数注入にする

`render-html.ts` は ZIP を知らない。画像バイトの解決は呼び出し側から関数で渡す。

```ts
/** 注記のファイル名を受け取り、埋め込み可能な data URL を返す。
 *  解決できない場合は undefined（レンダラはプレースホルダーに落とす）。 */
export type AozoraImageResolver = (fileName: string) => string | undefined;

export function renderDocumentToHtml(
  document: AozoraDocument,
  options?: { resolveImage?: AozoraImageResolver },
): string;
```

`resolveImage` 省略時は常に `undefined` を返す実装と等価。Stage A では
呼び出し側を変更せずに済み、Stage B で resolver を差し込むだけになる。

`renderDocumentToHtml()` は `document.blocks.map()` の構造（`:261-277`）を変えず、
resolver を `renderBlock()` → `renderInline()` へ引き渡す形にする。
**隣接ブロックを見るルックアヘッドは不要**（インライン実装にした結果、
キャプションは画像と同じ段落内に自然に並ぶ）。

### 10.2 出力 HTML

**解決できた場合**（公式 XHTML 変換に準拠）:

```html
<img class="illustration" width="320" height="322" src="data:image/png;base64,…" alt="コンドル博士の図">
```

**解決できなかった場合**（Stage A / 画像欠落時）:

```html
<span class="aozora-image-placeholder">［コンドル博士の図］</span>
```

`<img>` は一切出力しない。壊れた画像アイコンや alt 表示に依存しない。
角括弧は全角。`description` は必ずエスケープする。

**キャプション**:

```html
<span class="caption">神戸港頭の袂別</span>
```

---

## 11. Stage A の完了条件

1. 挿絵注記を含むテキストを `inputFormat: "aozora"` で変換したとき、本文中に
   `［＃…入る］` の生文字列が現れない。**本文と単一改行で隣接している場合を含む。**
2. 代わりに `［説明］` のプレースホルダーが現れる。
3. キャプション注記の3系統すべてが `.caption` としてレンダリングされる。
4. `unresolved-image` 診断が挿絵の個数だけ計上される。
5. 既存の青空文庫テキスト（挿絵なし）の出力が1バイトも変わらない。

---

## 12. Stage B: ZIP 入力

### 12.1 展開

`extractEpubArchive()`（`src/epub/archive.ts:230`）を**そのまま再利用する**。
名前が EPUB 固有なので共通化の余地はあるが、本仕様では呼び出しのみ行い、
リファクタリングは別タスクとする。

```ts
extractEpubArchive(bytes: Uint8Array, limits: EpubArchiveLimits): Map<string, Uint8Array>
// EpubArchiveLimits = { maxEntries, maxEntryBytes, maxTotalUncompressedBytes }
```

inflate 前に ZIP64・暗号化・圧縮方式・パストラバーサル・絶対パス・NUL バイト・
重複パス・エントリ数・解凍後サイズを検証する。投げるエラーは `EpubError` の
`INVALID_ZIP` / `UNSUPPORTED_ARCHIVE` / `TOO_MANY_ENTRIES` / `ENCRYPTED_EPUB` /
`UNSAFE_PATH` / `ENTRY_TOO_LARGE` / `UNCOMPRESSED_SIZE_TOO_LARGE`。

### 12.2 本文テキストの特定

青空文庫の配布 ZIP にはマニフェストがない。

1. ZIP 内の `.txt` エントリを列挙する。
2. ちょうど1つなら、それが本文。
3. 複数ある場合は **400 で拒否**する（`AOZORA_ZIP_AMBIGUOUS_TEXT`）。推測しない。
4. 0個なら 400（`AOZORA_ZIP_NO_TEXT`）。

**文字コードは既存の `decodeTextFile()`（`src/text-decode.ts:199-224`）にそのまま
通せばよい。** `encoding-japanese` により UTF-8 / Shift_JIS(CP932) の自動検出に
対応済みで、追加のデコード実装は不要。

### 12.3 画像ファイル名の解決規則

1. 注記のファイル名から**ベース名のみ**を取る（注記にディレクトリが書かれていても捨てる）。
2. ZIP エントリのうちベース名が一致するものを探す。大文字小文字は区別しない。
3. ちょうど1件なら採用。
4. 複数一致した場合は**解決しない**（`unresolved-image` 診断）。曖昧なまま採用しない。
5. 0件なら解決しない。

青空文庫の実配布物では画像がテキストと同階層か `fig/` 配下に置かれるが、
どちらであっても上記のベース名一致で拾える。**ディレクトリ構造は当てにしない。**

### 12.4 画像形式の判定

**拡張子と Content-Type を信用しない。マジックバイトで判定する。**

EPUB 経路は OPF マニフェストの `media-type` を信頼できるが、青空文庫 ZIP には
マニフェストがないため、この判定は新規に実装する必要がある。

| 形式 | マジックバイト | 採否 |
|---|---|---|
| PNG | `89 50 4E 47 0D 0A 1A 0A` | 採用（青空文庫の標準） |
| JPEG | `FF D8 FF` | 採用 |
| GIF | `47 49 46 38` | 採用 |
| その他 | — | 拒否（`unresolved-image` 診断） |

**SVG と WebP は受け付けない。** 青空文庫の記法が PNG 前提であり、SVG は
サニタイズが必要な攻撃面（script / foreignObject / SMIL）を持ち込むため、
対応する利得がない。EPUB 経路の `ALLOWED_IMAGE_MEDIA_TYPES`
（`src/epub/assets.ts:17-23`。`image/svg+xml` を含む）をそのまま流用**しない**のは
この理由による。

base64 化は `bytesToBase64()`（`src/epub/assets.ts:52-61`、`btoa()` の引数長制限を
避けるため `0x8000` バイトずつ処理する）を再利用する。

---

## 13. サイズ上限と CSP

### 13.1 現状

| 対象 | 定数 | 値 | env override |
|---|---|---|---|
| テキストアップロード | `MAX_TEXT_FILE_BYTES`（`src/text-normalize.ts:11`） | 5 MiB | 不可 |
| 生成 HTML | `MAX_GENERATED_HTML_BYTES`（`src/text-normalize.ts:15`） | 12 MiB | 不可 |
| EPUB アップロード | `DEFAULT_MAX_UPLOAD_EPUB_BYTES`（`src/epub-upload.ts:53`） | 48 MiB | 可 |
| EPUB 生成 HTML | `DEFAULT_MAX_EPUB_HTML_BYTES`（`src/jobs.ts:420`） | 32 MiB | 可 |

生成 HTML の上限は `src/workflow.ts:1298-1299` の prepare-text ステップで
`TextEncoder` によるバイト長比較として効いている。

**base64 は元バイトの約 1.33 倍に膨張する。** 挿絵を含む作品で 12 MiB 上限に
直撃するため、ZIP 入力時は別の上限が必要になる。

### 13.2 CSP は必須の変更（未確認事項ではない）

`TEXT_ARTICLE_CSP`（`src/text-html.ts:181-182`）は現在
`"default-src 'none'; style-src 'unsafe-inline'; font-src data:;"` で、
**`img-src` ディレクティブが存在しない**。`default-src 'none'` の下では
`<img src="data:image/png;…">` は確実にブロックされる。

Stage B では `img-src data:;` の追加が**必須**。これを忘れると画像が一切
表示されないまま「実装完了」に見える。

なお `AOZORA_DOCUMENT_CSS`（`img.illustration` を含む）は
`buildTextDocumentShell()` 内で `inputFormat === "aozora"` のときに注入されている
（`src/text-html.ts:294`）ため、CSS 側の手当ては不要。

### 13.3 追加する上限

```ts
// src/text-normalize.ts
/** aozora ZIP のアップロード上限。単一テキストの 5 MiB とは別枠。 */
export const DEFAULT_MAX_UPLOAD_AOZORA_ZIP_BYTES = 33_554_432; // 32 MiB
/** ZIP 入力時の生成 HTML 上限。base64 膨張（約1.33倍）を見込む。 */
export const DEFAULT_MAX_AOZORA_ZIP_HTML_BYTES = 50_331_648;   // 48 MiB
```

いずれも EPUB に倣い `resolveMaxUploadAozoraZipBytes(env)` /
`resolveMaxAozoraZipHtmlBytes(env)` で `wrangler.jsonc` から上書き可能にする
（`resolveMaxEpubHtmlBytes`、`src/jobs.ts:429-434` と同型）。

**既存の `MAX_TEXT_FILE_BYTES` と `MAX_GENERATED_HTML_BYTES` は変更しない。**
上限の切り替えは「入力が ZIP かどうか」だけで決まる。

ZIP 展開の limits:

```ts
{ maxEntries: 512, maxEntryBytes: 16 * 1024 * 1024, maxTotalUncompressedBytes: 64 * 1024 * 1024 }
```

EPUB（既定 5000 / 32 MiB / 192 MiB）より絞る。青空文庫の1作品分としては十分に広い。

### 13.4 下流の制約との整合

- Browser Rendering の PDF 上限は 48 MiB（`wrangler.jsonc:16,22`）。
- converter のメモリ実測は約 7 MiB/ページ（コンテナ `standard-1` = 4 GiB）。

HTML 48 MiB → PDF は圧縮が効くため通常は収まるが、**高解像度の挿絵を大量に
含む作品では PDF 側の上限に当たりうる。** その場合は既存の PDF サイズ超過エラーが
先に出る。本仕様では新たな緩和策を入れず、エラーメッセージで挿絵が原因である
ことが分かるようにするに留める（§16）。

---

## 14. CSS（縦書き・改ページ）

`packages/aozora-text/src/styles.ts` に追加する。

```css
.caption {
  font-size: 0.85em;
}

.aozora-image-placeholder {
  /* プレースホルダーは本文と区別がつく程度に留め、目立たせない */
  opacity: 0.7;
}
```

**挿絵本体の CSS は既存の `img.illustration`（`styles.ts:78-82`、
`width/height: auto !important` と `break-inside: avoid`）をそのまま使う。**
v1 は `figure.aozora-illustration` を新設していたが、インライン実装では
`figure` を出さないため不要になった。既存ルールで足りる。

**設計上の制約（プロジェクトの既存方針）**:

- `writing-mode: vertical-rl` は `html` にのみ付与する。入れ子要素に付けると
  印刷時にページ分割できず白紙ページが出る既知バグがある
  （`packages/aozora-text/src/styles.ts:14-29`、`src/text-html.ts:113-134`）。
  **挿絵まわりに `writing-mode` を付けてはならない。**
- 本文テキストを最優先し、画像はページに収まらない場合に縮小・切り捨てで譲る。
- EPUB の表紙 CSS（`src/epub/html.ts:611-640`）には「幅・高さの両方を明示しないと
  `max-height: 100%` が効かず実測でページをはみ出した」という実機由来の経緯がある。
  挿絵でも同種の問題が起きうるため、§20 Phase 5 で必ず実 PDF を目視すること。
  はみ出しが起きた場合の追加策として `max-width` / `max-height` の付与を検討するが、
  **`img.illustration` の既存ルールは URL 抽出経路と共有されている**ため、
  テキスト経路だけに効くセレクタで上書きすること（URL 経路の挙動を変えない）。

---

## 15. 変更箇所一覧

### 必須（Stage A）

| ファイル | 変更 |
|---|---|
| `packages/aozora-text/src/types.ts` | `AozoraImageInline` / `AozoraCaptionInline` 追加、`AozoraDiagnostic["kind"]` に `unresolved-image` 追加 |
| `packages/aozora-text/src/parse-inline.ts` | `handleAnnotation()` に挿絵・キャプション分岐、`rangeStack` にキャプション kind |
| `packages/aozora-text/src/render-html.ts` | `renderInline()` に分岐、`extractPlainText()` の `visitInline`、`headingPlainText()`、`renderDocumentToHtml()` に `resolveImage` オプション |
| `packages/aozora-text/src/count.ts` | `countInline()` に算入 |
| `packages/aozora-text/src/styles.ts` | `.caption` / `.aozora-image-placeholder` |
| `src/text-prepare.ts` | `prepareAozora()`（`:156-214`）の診断集計に `unresolvedImages` を追加 |
| `src/workflow.ts` | ログに `unresolvedImages` 件数を追加 |

### 必須（Stage B）

| ファイル | 変更 |
|---|---|
| **`src/text-html.ts:181-182`** | **`TEXT_ARTICLE_CSP` に `img-src data:;` を追加（§13.2。忘れると画像が出ない）** |
| `src/text-normalize.ts` | ZIP 用の上限定数（§13.3） |
| `src/jobs.ts` | `resolveMaxUploadAozoraZipBytes` / `resolveMaxAozoraZipHtmlBytes` |
| `src/text-upload.ts` | Content-Type 許可リストに `application/zip`、ZIP 時の上限切り替え |
| `src/index.ts`（`handleCreateTextJob`、`:538-609`） | **`peekLeadingBytes()` + `FixedLengthStream` による先読み配線の新規追加**（§6.2）、ZIP 判定、`inputFormat` 整合チェック |
| `src/aozora-zip.ts`（新規） | ZIP 展開・本文特定・画像インデックス構築・マジックバイト判定・resolver 生成 |
| `src/text-prepare.ts` | `prepareAozora()` に resolver を渡す経路 |
| `src/workflow.ts:1298-1299` | prepare-text ステップの HTML 上限切り替え |
| `wrangler.jsonc` | `MAX_UPLOAD_AOZORA_ZIP_BYTES` / `MAX_AOZORA_ZIP_HTML_BYTES` |

### 原則不要

- `converter/`（§3.2）、`xtctool`
- `migrations/`（Markdown 追加時も D1 変更は不要だった）
- `src/aozora.ts`（URL 抽出経路）、`src/pdf.ts`
- `packages/aozora-text/src/chapters.ts`、`parse-document.ts`（§8.3 参照）

---

## 16. エラー

| 状況 | HTTP | コード / 文言 |
|---|---|---|
| ZIP だが `inputFormat` が aozora でない | 400 | `ZIP input requires inputFormat: aozora` |
| ZIP 内に `.txt` が無い | 400 | `AOZORA_ZIP_NO_TEXT` |
| ZIP 内に `.txt` が複数 | 400 | `AOZORA_ZIP_AMBIGUOUS_TEXT` |
| ZIP 展開失敗（暗号化・不正・上限超過） | 400 / 413 | `extractEpubArchive` の `EpubError` コードをマッピング |
| ZIP サイズ超過 | 413 | 既存の `checkContentLength` 経路（`src/index.ts:546-561`） |
| 生成 HTML が上限超過 | 500（非リトライ） | 既存の `NonRetryableError`。**挿絵が原因の可能性に言及する文言にする** |

レスポンス形は `/jobs/text` の既存レガシー形 `{"error": "<string>"}` に揃える
（`src/text-upload.ts:23-24` に経緯の記載あり）。

フロントエンドの `frontend/src/lib/server-error-text.ts` に i18n マッピングを追加する。

---

## 17. フロントエンド

| ファイル | 変更 |
|---|---|
| `frontend/src/lib/input-file-kind.ts` | `.zip` / `application/zip` の判定 |
| `frontend/src/lib/text-file-validate.ts` | ZIP 時のサイズ上限を 32 MiB に切り替え |
| `frontend/src/components/FileDropZone.svelte` | `accept` に `.zip` |
| `frontend/src/components/TextOptions.svelte` | ZIP 選択時は `inputFormat` を aozora に固定・他形式を disabled 表示 |
| `frontend/src/components/TextInputPanel.svelte` | ZIP は本文プレビュー不可の旨を表示 |
| `frontend/src/lib/i18n.svelte.ts` | ja / en の文言追加 |
| `frontend/src/lib/server-error-text.ts` | §16 のエラーコード |

**ZIP をクライアント側で展開しない。** プレビューのためだけにフロントエンドへ
unzip 依存を持ち込むのは割に合わない。ZIP 選択時はファイル名とサイズのみ表示し、
X3 プレビューは無効化する。

---

## 18. ログ・観測

`src/workflow.ts` の既存の prepare-text ログに件数のみ追加する。

```
（既存）recognizedAnnotations, unsupportedAnnotations, malformedAnnotations, truncatedDiagnostics
（追加）imageAnnotations       … 認識した挿絵注記の数
（追加）unresolvedImages       … 実体を解決できなかった数
（追加）embeddedImageBytes     … 埋め込んだ画像の合計バイト数（base64 化前）
```

**ファイル名・説明文・本文は出さない。** 既存の「本文を漏らさない」方針を維持する。
`embeddedImageBytes` は HTML 上限に当たった事例の事後分析に必要になるため入れる。

---

## 19. テスト仕様

配置規則は既存どおり。バックエンドは `test/` 直下フラット、共有パッケージは
`packages/aozora-text/test/`。ランナーは vitest（`npm test` = `vitest run`）。

**フィクスチャはバイナリをコミットせず、テスト内で生成する。**
EPUB が `test/fixtures/epub/build-epub.ts` の `buildEpubZip()` / `makeMinimalPng()` で
同じことをしている。青空文庫 ZIP 用にも同型のヘルパーを作る
（`test/fixtures/aozora/build-aozora-zip.ts`）。

### 19.1 パーサー（`packages/aozora-text/test/parse-inline.test.ts`）

- 標準記法 → `AozoraImageInline`（description / fileName / width / height）
- 旧記法（サイズなし） → `width` / `height` が `undefined`
- キャプション付きの図 → `description` が `「…」のキャプション付きの図` 全体、
  かつ**外字注記として誤判定されない**（§9.1 の分岐順序の検証）
- 説明部に丸括弧を含むケース → ファイル名が誤って切り出されない
- `×` が半角 `x` → マッチせず `rawAnnotation` にフォールバック
- ファイル名が空 → `malformed-annotation`
- キャプション3系統それぞれ → `AozoraCaptionInline`
- 既存の後置注記（傍点・縦中横）とキャプション後置型が競合しない

### 19.2 チャンク境界（`packages/aozora-text/test/parse-document.test.ts`）

**この機能の根幹なので独立して検証する。**

- 挿絵注記が本文と**単一改行で隣接**している場合に認識される（最頻出パターン）
- 挿絵注記が**空行で挟まれ単独チャンク**の場合にも認識される
- 挿絵注記の直後の行にキャプションが来る場合（空行なし）に両方認識される

### 19.3 レンダラ（`packages/aozora-text/test/render-html.test.ts`）

- resolver なし → `.aozora-image-placeholder`、`<img>` を含まない
- resolver あり → `<img class="illustration" width height src="data:…" alt>`
- `description` の HTML エスケープ
- `extractPlainText()` が画像の `description` とキャプション本文を含む

### 19.4 ZIP（`test/aozora-zip.test.ts`）

- 正常系: テキスト1・PNG2 の ZIP → 画像2枚が data URL で埋まる
- `.txt` が 0 / 2 → それぞれのエラー
- 画像がベース名一致で解決される（`fig/` 配下でも直下でも）
- ベース名が重複 → 解決しない（`unresolved-image`）
- 拡張子は `.png` だが中身が PNG でない → 拒否
- SVG → 拒否
- Shift_JIS の `.txt` が正しくデコードされる
- ZIP 爆弾・パストラバーサル → `extractEpubArchive` のエラーが伝播する

### 19.5 統合（`test/text-upload.test.ts`）

- ZIP + `inputFormat: markdown` → 400
- ZIP のサイズ上限が 32 MiB に切り替わる
- 生成 HTML 上限が ZIP 時に 48 MiB に切り替わる
- **生成 HTML の CSP に `img-src data:` が含まれる**（§13.2）

### 19.6 回帰

- **挿絵を含まない既存の青空文庫テキストの出力が変わらない**（最重要）
- plain / markdown の出力が変わらない
- 既存の `packages/aozora-text/test/*.test.ts` 全通過

---

## 20. 実装順序

### Phase 1: パーサーとレンダラ（Stage A）

`packages/aozora-text/` のみ。§8・§9・§10・§14 を実装し、§19.1〜19.3 を通す。
**§19.6 の回帰テストと §19.2 のチャンク境界テストを先に書く。**
この時点で `src/` は無変更。

### Phase 2: バックエンド統合（Stage A）

`src/text-prepare.ts` の診断集計と `src/workflow.ts` のログ。§11 の完了条件を満たす。
**ここで一度デプロイして、挿絵を含む既存作品でプレースホルダーが正しく出ることを確認する。**

### Phase 3: ZIP 入力（Stage B）

CSP 変更、`src/aozora-zip.ts` 新規、上限定数、先読み配線。§19.4・§19.5。

### Phase 4: WebUI

§17。ZIP のアップロードから完了までを WebUI で通す。

### Phase 5: 実環境確認

§21 の未確認事項をすべて潰す。特に:

- 実際の青空文庫配布 ZIP を 1 つ入手し、内部構造（画像の配置階層、注記のファイル名と
  実ファイル名の一致、挿絵注記の前後に空行があるか）を確認する。
- 生成 HTML をローカル Chrome で print-to-PDF し、**画像として**目視で改ページを確認する
  （`pdftotext` は縦書きを拾わないため、テキスト抽出では検証にならない）。
- 本番デプロイ後は旧インスタンスの残留があるため 2 分待ってから検証する。
- 長編は `/jobs` 経路で検証する。

---

## 21. 未確認事項

実装着手前に潰すこと。本仕様の前提が崩れる可能性がある順。

1. **挿絵注記の前後に空行があるか。** §8.1 の設計根拠は「本文と単一改行で隣接する」
   という公式記入例に基づく。インライン実装は空行があってもなくても動くため
   仕様は崩れないが、実物での確認は必要。
   **関連する既存の潜在バグ**: 既存の単独行制御注記（`［＃改ページ］`、字下げ等）は
   空行で挟まれていないと認識されない。実配布物で改ページ注記が本文と隣接している
   場合、現状でも認識されていない可能性がある。本仕様では修正しない（§5）が、
   確認して結果を記録する価値がある。
2. **青空文庫配布 ZIP の実構造。** 画像がテキストと同階層か `fig/` 配下か、
   注記のファイル名が実ファイル名と完全一致するか。§12.3 の解決規則はどちらでも
   動く設計だが、実物で確認していない。
3. **縦書きページでの挿絵の実挙動。** `img.illustration` は `width/height: auto` で
   上限を持たない。ページからはみ出す場合の追加ルールが要るかは実測で決める（§14）。
4. **グレースケール化後の判読性。** converter がグレー化するため、
   写真系の挿絵が潰れないかを実機で見る。
5. **ページ数・メモリ。** 挿絵の多い作品で converter の実測 7 MiB/ページを
   超えないか。挿絵は PDF ページを重くするため、テキストのみの実測値が
   そのまま当てはまらない可能性がある。

**解決済み（v1 では未確認としていたもの）**:

- 文字コード → `decodeTextFile()` が Shift_JIS 対応済み（§12.2）
- `img.illustration` のテキスト経路への注入 → 注入済み（§13.2）
- CSP → `img-src` が無く**追加必須**。未確認事項ではなく確定した作業（§13.2）

---

## 22. 技術リスク

| リスク | 影響 | 緩和 |
|---|---|---|
| CSP の `img-src` 追加漏れ | 画像が一切出ないまま完了に見える | §19.5 に CSP のテストを入れる |
| 縦書きで挿絵がページからはみ出す | 本文欠落 | Phase 5 で実 PDF 目視。URL 経路と共有の `img.illustration` を壊さないセレクタで上書き |
| base64 膨張で HTML 上限に当たる | 変換失敗 | ZIP 時のみ上限を 48 MiB に切り替え（§13.3）。`embeddedImageBytes` をログ化 |
| PDF が 48 MiB 上限を超える | 変換失敗 | 本仕様では緩和しない。エラー文言で挿絵が原因と分かるようにする |
| キャプション後置型が既存の後置注記と競合 | 誤変換 | §19.1 に競合テスト |
| 既存の青空文庫作品の出力が変わる | 回帰 | §19.6 の回帰テストを Phase 1 で先に書く |
| ZIP 先読み配線の新規追加 | Stage B の作業量が見積もりより大きい | EPUB 経路（`src/index.ts:673-694`）をそのまま参考にする |

---

## 23. 受け入れ基準

1. 挿絵注記を含むテキストで、本文に `［＃…入る］` の生文字列が出ない
   （本文と隣接している場合を含む）。
2. ZIP 入力で挿絵が実際に PDF・XTC 上に描画される。
3. 縦書きレイアウトで挿絵の前後に白紙ページが発生しない。
4. 挿絵が本文をページ外に押し出さない。
5. 挿絵なしの既存作品の出力が 1 バイトも変わらない。
6. `npm test` および `npm run test --prefix frontend` が全通過。
7. 実機（XTC 端末）で挿絵入り作品を 1 冊表示し、画像とキャプションが判読できる。

---

## 24. 完了時のドキュメント更新

- `README.md` に ZIP 入力と対応注記を追記する。
- 本仕様書の §21 に確認結果を追記する（項目は消さない）。
- 縦書きでの挿絵の実測結果と、§21-1 の既存注記のチャンク境界問題の確認結果は、
  知見としてプロジェクトメモリに残す価値がある。
