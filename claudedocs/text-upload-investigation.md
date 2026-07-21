# TXTファイルアップロード機能 実装調査レポート

調査日: 2026-07-21
対象: `/Users/haruki/Documents/html2xtc-text-upload`（git worktree）
入力仕様書: `/Users/haruki/Downloads/html2xtc-text-upload-spec.md`
参考実装: PDFアップロード機能（本番デプロイ済み）。`claudedocs/pdf-upload-investigation.md` も存在するが、**本レポートはコード実物を正としてゼロから再調査した内容**（同レポート執筆後にコードが更新されているため）。

このレポートは実装エージェントがコードを再探索せずに着手できるよう、実在のファイルパス・行番号・関数名・型名を記載する。**§0 に最重要の落とし穴（renderPdfFromHtml の非自明な非互換性、workerd の shift_jis 未成熟）をまとめてある。ここを読んでから実装すること。**

---

## 0. 最重要サマリ（先に読むこと)

1. **`renderPdfFromHtml`（`src/pdf.ts:776-818`）はTXT用にそのまま再利用できない。** `fontCss !== null` のとき常に `buildPrintRules(options)`（`src/pdf.ts:468-472`）を追加スタイルとして注入する。これはURLスクレイピング用のヒューリスティックCSS（`body,p,div,... { font-size: 10pt !important }` 等、`BODY_TEXT_SIZE_RULES`/`LAYOUT_RESET_RULES`/`HIDE_CHROME_RULES`、`@page { size: 66mm 99mm; margin: 4mm }` 固定）であり、TXTの可変フォントサイズ(12-32px)・可変余白(0-120px)・528×792px固定ページと**直接衝突する**（`!important` なので上書きは困難）。対策は2案:
   - (推奨) `src/pdf.ts` に `renderPdfFromHtml` と同じ `BROWSER.quickAction` 呼び出しパターンで、`buildPrintRules` を注入しない新関数（例 `renderSelfStyledHtmlPdf`）を追加する。TXTの `article.html` 自身が `<style>` に `@page`/typography を全て埋め込む（仕様書 §9.3-9.6 の方針どおり）ので、注入すべきは `fonts.css`（`@font-face` のみ）だけでよい。
   - (非推奨) `buildPrintRules` を options で条件分岐させる改修は既存のURL/PDF経路への影響範囲が大きく、`test/pdf.test.ts` が固定文字列をpinしているため回帰リスクが高い。
   - `PDF_OPTIONS`/`PDF_GOTO_OPTIONS`（`src/pdf.ts:725-740`）はモジュール内 `const` で非export。新関数を追加する場合はこれらをexportするか複製する。
2. **workerd の `TextDecoder("shift_jis")` は現時点(2026-07-21)で信頼できない。** Cloudflare公式ドキュメント（developers.cloudflare.com/workers/runtime-apis/encoding/）は `TextDecoder` を「a UTF-8 decoder」としか説明しておらず、非UTF-8ラベルの公式サポートを明記していない。workerd側では `text_decoder_cjk_decoder` という compatibility flag 配下でCJK系レガシーエンコーディング(shift_jis含む)の対応が進行中だが、[cloudflare/workerd#6193](https://github.com/cloudflare/workerd/issues/6193)（2026-02オープン、2026年時点でまだ議論中）により**ストリーミングデコードで既知のバグ**があり、フラグを有効にしても非決定的な結果になりうる。本プロジェクトの `wrangler.jsonc` には現在この互換フラグの明示指定がない。**Worker側（`text-decode.ts` の prepare-text step）でもフロントエンドと同じ `encoding-japanese` 系の純JS実装を使うことを強く推奨する**（仕様書 §10.1 はフロントのみ言及しているが、Workerでも同じ理由で必要）。5MiB以下なら純JS変換のCPUコストは許容範囲。
3. **Container（`converter/app.py`）はタイトルをPDFメタデータから読み取るのみで、著者(author)を渡す経路が現状ない。** `config-x3.toml`（`converter/config-x3.toml:16`）には `[output].author = ""` フィールドが存在するが、`config_with_title()`（`converter/app.py:191-203`）は `title` しか上書きしない。TXTのタイトルは生成HTMLの `<title>` → Chromiumのprint-to-PDFメタデータ → `read_pdf_metadata()`（`converter/app.py:154-167`）→ `X-Xtc-Title` という既存経路がそのまま使えるが、**著者をXTCメタデータに反映するには `converter/app.py` の改修が必要**（`config_with_title` を `config_with_title_author` 的に拡張し、`/convert` の呼び出し元 = Worker からheader等で渡すか、PDFメタデータのAuthorフィールドを読む）。これは仕様書 §16 が「必要に応じて拡張する」と予告している変更そのもの。**Containerの変更が必要になる**ことをスコープに含めること（HTML本文への著者表示だけなら既存の仕組みで対応可能、XTCメタデータへの反映は別途対応要）。
4. **フロントエンドに既存の「フォント選択UI」は存在しない。** `grep -rn "font" frontend/src` の結果、フォント選択UIはゼロ件。URL変換フォーム(`ConvertForm.svelte`)は `{url, mode:"extract"}` のみをPOSTし、layout/fontは一切UIから送っていない（サーバー側デフォルトのみ使用）。PDF変換パネルは `pdf_advanced_note` で明示的に「PDFはフォント変更不可」と案内している。**TXT用フォント選択欄はゼロから新規実装が必要**。バリデーション規則（「既存フォント検証規則」）の実体は `sanitizeFontFamily`（`src/fonts.ts:71-83`）: 先頭が英数字、以降は英数字・空白・ハイフンのみ、64文字以内、`/^[A-Za-z0-9][A-Za-z0-9 -]*$/`。Google Fontsの候補一覧UIも存在しない（自由入力＋このregexバリデーションのみ）。BIZ UDPGothic / BIZ UDMincho は両方とも既に `src/fonts.ts:50`（`DUAL_WEIGHT_FAMILIES`）で400/700ウェイト対応済みなので、TXTのデフォルトフォントとして矛盾なく使える。
5. **JobSourceType・JobStatus・エラー文言テーブルの拡張が必須。** `frontend/src/lib/job-entry.ts:6` の `JobSourceType` は `"url" | "pdf"` のみ。`frontend/src/lib/i18n.svelte.ts:8` の `JobStatus` は `"queued"|"rendering"|"converting"|"completed"|"failed"|"expired"` のみで **`"preparing"` が無い**（仕様書 §19 の `preparing` = 「本文を組版中」に対応する状態が既存型に無い）。`src/jobs.ts` の `JobApiStatus`（59-64行目）も同様に `preparing` を持たない。これらは後述 §5 で詳細に扱う。

---

## 1. バックエンド（Worker）調査結果

### 1.1 ルーティング（`src/index.ts`）

- `route()` 関数は 126-200行目。`/jobs/pdf` は 158-163行目で `/jobs/:jobId` 正規表現（175行目）より前に判定されている。TXT用の `/jobs/text` も同じ位置（`/jobs/pdf` の直後、`/api/books` より前）に追加すればよい。
- `handleCreatePdfJob`（351-427行目）が実装パターンの模範。処理順序（コメントで明記、343-350行目）: Content-Type検証 → Content-Length検証 → レート制限（`enforceRateLimit`, 377-380行目）→ X-File-Name デコード → X-Pdf-Options デコード・検証 → jobId発行 → R2ストリーム保存（`saveUploadedPdf`）→ Workflow作成 → 202レスポンス。TXTもこの順序を踏襲すべき（仕様書 §13.1 の想定と一致）。
- エラーレスポンス形式は全て `{"error": "<string>"}`（レガシー形式）。`route()` 系はこの形式で統一されており、`src/router.ts` 経由の新方式（`{"error":{"code","message"}}`）は使っていない。TXTも `/jobs/pdf` と同じレガシー形式にすること（`frontend/src/lib/convert.svelte.ts` の `JobsPostResponse.error?: string` がこの前提でパースしている）。
- `mapWithPhaseProbe`（494-508行目）: `needsPhaseProbe`（`src/jobs.ts:88-95`）が true の間、R2の `inputPdfKey`→ 無ければ `intermediatePdfKey` の順でプローブして rendering/converting を判別している。TXTは新しいフェーズ `preparing` を持つため、この関数の拡張または新規プローブ関数が必要（詳細 §1.4）。
- `deleteBestEffort`（637-643行目）はモジュールスコープの汎用ヘルパーで、TXTの失敗時クリーンアップにもそのまま使える。

### 1.2 `src/pdf-upload.ts` の再利用可能関数

TXT用の `text-upload.ts` は以下を強く参考にすべき（一部はそのままimportして共用可能）:

- `decodeBase64Url`（`src/base64url.ts:26-49`）: X-File-Name / X-Text-Options のデコードにそのまま使える。UTF-8厳密デコード（`fatal:true`）、不正なら `null`。**共用可**（import元は `src/base64url.ts`、pdf-upload.ts固有ではない）。
- `checkContentLength`（`src/pdf-upload.ts:66-84`）: missing→411, 非数値/0以下→400 (`{kind:"invalid"}`), 上限超→413相当のロジック。**構造をそのままTXT用に複製**（`maxBytes` 引数を5MiBに変えるだけ。関数自体は汎用なので `env` に依存しない形にすればそのままexport/共用も可能）。
- `sanitizeUploadFilename`（`src/pdf-upload.ts:96-119`）: 制御文字除去→パス区切り除去→NFC正規化→255文字キャップ→拡張子付与、のロジックがTXT仕様§11.4と完全一致（拡張子だけ `.pdf`→`.txt` に変える）。**ほぼそのまま複製可能**。
- `decodeFilenameHeader`（127-133行目）: ヘッダー欠如時はデフォルト値へfail-soft（クライアントエラーにしない）というポリシーもTXTのX-File-Nameに踏襲すべき。
- **X-Text-Options は X-Pdf-Options と方針が異なる点に注意**: `decodePdfOptionsHeader`（246-261行目）はヘッダーが無ければ `DEFAULT_PDF_OPTIONS` にfail-soft、あるが不正なら400。仕様書§11.5「デコード・JSON解析・スキーマ検証失敗は400」は「不正なら400」の部分のみを指す。ヘッダー欠如時の挙動（default fallback か 400 か）は仕様書に明記が無いため実装判断が必要——PDFの前例に倣い「欠如はdefaultへfail-soft、存在するが不正なら400」を推奨。
- `saveUploadedPdf`（340-375行目）のパターン（R2 put → `head()` でサイズ検証 → 不一致ならbest-effort削除して400）は `saveUploadedText` としてそのまま踏襲可能。TXTは `httpMetadata.contentType: "text/plain"`、`customMetadata: {filename, sourceType: "txt"}`（仕様書§11.8どおり）。
- `uploadedPdfErrorMessage` / `UPLOADED_PDF_ERROR_MESSAGES`（263-317行目）はPDF Container固有。TXTはContainerを経由しない自前バリデーション（文字コード判定失敗・文字数超過等）なので、この関数のパターン（`code`→安定メッセージのマッピング）だけを踏襲し、TXT用の独自エラーコード表を `text-normalize.ts`/`text-decode.ts` 側に持つことになる。

### 1.3 `src/workflow.ts` — URL変換のフォント/PDF生成経路

- `resolveSource`（38-46行目）: `ConvertJobParams.source` の判別。TXTは `source.kind === "text"` の新ブランチを `ConvertWorkflow.run()`（72-83行目、PDFの `if (source.kind === "pdf") { return await this.runUploadedPdf(...) }` と同じ位置）に追加する形になる。
- **既存の「HTML→PDF」経路は `render-pdf` ステップ（169-247行目）の中の `article !== null` 分岐（193-215行目）**。ここで `renderPdfFromHtml(this.env, await article.text(), fontCss, options)` を呼んでいる。この呼び出し自体は再利用できるが、**§0-1 に書いたとおり `renderPdfFromHtml` は `buildPrintRules(options)` を強制注入するため、TXT用には直接使えない**。TXT用の `render-text-pdf` ステップは、この関数の構造（R2から article.html 取得 → fonts.css 取得 → PDF生成 → サイズ上限チェック → R2保存）を模倣しつつ、実際のレンダリング呼び出しだけ新関数（§0-1で提案した `renderSelfStyledHtmlPdf` 等）に差し替える。
- フォントCSSの中間キー: `articleHtmlKey`/`fontsCssKey`（`src/jobs.ts:28-39`）は `intermediate/{jobId}/article.html` / `intermediate/{jobId}/fonts.css` を返す既存関数で、**TXT用にそのまま使い回せる**（jobIdが違うだけでprefixもファイル名も仕様書§12.3の想定と完全一致）。新規関数を作る必要はない。
- `intermediatePdfKey`（`src/jobs.ts:19-21`）も同様に `intermediate/{jobId}/source.pdf` を返す既存関数で、TXTの中間PDFキーとしてそのまま流用可能（仕様書§12.4の期待と一致）。
- サイズ上限: `resolveMaxPdfBytes`（`src/jobs.ts:256-261`, デフォルト20MiB）がTXTのレンダリング後PDFにもそのまま適用される想定（`workflow.ts:234-240`のロジックを模倣）。`NonRetryableError` で失敗させるパターンもそのまま。
- 後処理（delete-intermediates）: `workflow.ts:314-332`（`finally` ブロック、`delete-intermediate-pdf` ステップ名）のパターンをTXT用に複製（`delete-text-intermediates`、仕様書§12.6のキー4種を全て削除）。

### 1.4 `src/jobs.ts` — ステータス判定とTXTの `preparing` フェーズ

現状のフェーズ判定は「rendering/converting」の2値のみ（`needsPhaseProbe`/`mapInstanceStatus`、88-131行目）。判定はR2オブジェクトの有無をプローブして行う（PDFファイルが存在するかどうかの1軸）。TXTジョブは3フェーズ（preparing→rendering→converting）が必要なため、**プローブ軸を増やす拡張が必要**:

- `preparing`: `intermediate/{jobId}/article.html` が未生成
- `rendering`: `article.html` は生成済みだが `intermediate/{jobId}/source.pdf` が未生成
- `converting`: `source.pdf` も生成済み

実装方針の推奨: `mapInstanceStatus` のシグネチャを汎用化する（例えば `hasIntermediatePdf: boolean` の代わりに `phase: "preparing"|"rendering"|"converting"` を渡す）と、既存のURL/PDF呼び出し側改修が発生し回帰リスクが増える。**代わりに、TXT専用の `mapTextInstanceStatus` 関数を新設し、`mapInstanceStatus` 自体は変更しない**（`mapPdfInstanceStatus` が既存関数を forced `true` でラップして新設された前例、147-152行目のドキュメントコメント参照、と同じ手法）。`src/index.ts` の `mapWithPhaseProbe`（494-508行目）は、TXTジョブの判定にはさらに `articleHtmlKey(jobId)` の存在確認を追加する必要がある（`inputPdfKey`→`intermediatePdfKey`の2段probeに対し、TXTは `inputTextKey`→`articleHtmlKey`→`intermediatePdfKey`の3段probe、または「まずTXT入力の有無でPDFジョブ/TXTジョブ/URLジョブを判別してから、ジョブ種別ごとの分岐プローブへ」という構造）。**この判別ロジックの正確な設計は実装前に固めること**（ジョブ種別を判別するR2キーの探索順序が増えるほどレイテンシも増えるため）。
- `JobApiStatus`（`src/jobs.ts:59-64`）に `"preparing"` を追加する必要がある。

### 1.5 workerd の shift_jis デコード（§0-2 の詳細）

- `wrangler.jsonc` の `compatibility_date` は `"2026-07-01"`（4行目）。`compatibility_flags` の指定なし。`text_decoder_cjk_decoder` フラグの既定日は本調査時点で未確定（GitHub issueが2026-02オープンで議論継続中）。
- 対応方針（推奨）: Worker側の `text-decode.ts` で `encoding-japanese`（または同等の純JSライブラリ）を使い、`TextDecoder` のネイティブ非UTF-8サポートには依存しない。UTF-8のデコードのみ `TextDecoder("utf-8", {fatal:true})`（`src/base64url.ts:45`と同じパターン）を使い、Shift_JIS/CP932は完全に純JS実装に倒す。これにより仕様書§10.1の「候補: encoding-japanese」がWorker側にも及ぶことになり、フロント・バックエンドで同一ライブラリ・同一デコード結果を保証できる（自動判定の一貫性にも寄与）。
- ライブラリはWorkersランタイム（V8 isolate、Node.js API非対応部分あり）で動作確認が必要。`encoding-japanese` はNode.js依存が薄い純JSライブラリで、Workers環境での動作実績が比較的多い（要実機確認だが本調査では未検証）。

### 1.6 レート制限

- `enforceRateLimit`（`src/ratelimiter.ts:57-90`）は `POST /convert` と `POST /jobs` の**共有カウンタ**（IPキーに namespace prefixなし）。`/jobs/pdf` も同じ関数をハンドラ内で呼んでいる（`src/index.ts:377`）。仕様書§11.9「既存変換開始エンドポイントと同じIP単位の制限」との一致を確認——**`/jobs/text` も同じ `enforceRateLimit(request, env)` をそのまま呼べばよい**（新しいpurposeキーは不要。`enforcePurposeRateLimit`は認証・ペアリング等の別用途向けで、変換系には使われていない）。

### 1.7 型定義の拡張（`src/types.ts`）

- `ConvertSource`（26-28行目）に `| { kind: "text"; key: string; filename: string; size: number }` を追加。
- `ConvertJobParams`（84-109行目）に `textOptions?: TextConvertOptions` を追加（`pdfOptions` と並列）。
- `TextConvertOptions` 型自体は仕様書§6.1どおり新規定義（`src/text-options.ts`、フロントは `frontend/src/lib/text-options.ts` にミラー、PDFの `PdfConvertOptions`/`pdf-options.ts` が両方に存在する前例と同型構成）。

---

## 2. フロントエンド調査結果

### 2.1 既存コンポーネント構造とTXT統合方針

- `ConvertForm.svelte`（`frontend/src/components/ConvertForm.svelte`）が全入力の起点。42-72行目: `pdfFile` state が非nullなら `PdfInputPanel` を表示、それ以外はURL入力フォーム＋`PdfDropZone`。ファイル選択は `onFileSelected`（27-35行目）で `validatePdfFile` による検証のみ行い、成功したら `pdfFile = file` として即座にプレビューへ（**サーバー送信はしない** — 仕様書§4.2「ファイル選択時にはアップロードしない」と設計思想が完全一致）。
- **`PdfDropZone.svelte` は名前も実装もPDF専用ではあるが、構造自体は汎用**: `accept="application/pdf,.pdf"`（60行目）のinput要素と `onFileSelected: (file: File) => void` コールバックのみに依存しており、ファイル種別判定はしていない（呼び出し元の `onFileSelected` 内で行う設計）。仕様書§10.2-10.3「ドロップゾーンをPDF/TXT共用化」との対応:
  - **推奨**: `PdfDropZone.svelte` を `FileDropZone.svelte` にリネームし、`accept` をprop化（`accept="text/plain,.txt,application/pdf,.pdf"`）。呼び出し元（`ConvertForm.svelte`）でファイルの拡張子/MIME/マジックバイトを見てPDF/TXTを判別し、`pdfFile`/`txtFile` のどちらかのstateにセットする（仕様書§10.3「複数ファイルは受け付けない。判定後にPDFパネルまたはTXTパネルへ分岐する」との対応）。
  - リネームすると `PdfDropZone` を参照している箇所（`ConvertForm.svelte:7,49`）の更新が必要。コンポーネント名の衝突は無い（現状 `FileDropZone.svelte` は存在しない）。
- **フォント選択UIは §0-4 のとおりゼロから新規実装**。参考にできる既存UIパターンは `PdfOptions.svelte` のトグル/スライダー類（`.seg` ボタン群、`input[type=range]` 等のスタイル、73-213行目）——CSSクラスとインタラクションパターンは流用できるが、フォント名入力欄（text input＋バリデーション表示）自体は新規。

### 2.2 `convert.svelte.ts` — `submitPdf` パターン(191-247行目)

- `XMLHttpRequest` を使う理由（仕様書§10.9と一致）: `fetch`ではアップロード進捗が安定して取れないため。`xhr.upload.onprogress`（203-205行目）で `Content-Length` ベースの進捗計算。
- ヘッダー設定パターン（197-201行目）: `Content-Type`, `X-File-Name`（`encodeFileNameHeader`）, `X-Pdf-Options`（`encodePdfOptionsHeader`）。TXT用 `submitText` はこれと並列に実装し、`Content-Type: text/plain`、`X-File-Name`、`X-Text-Options` を設定する。
- `PdfUploadResult`/`PdfUploadSession`/`PdfUploadHandle` 型（172-185行目）はPDF専用命名だが構造は汎用。**型を汎用名にリネームするか、TXT用に並行した型（`TextUploadResult`等）を新設するかは実装判断**（リネームの方が重複を避けられるが、呼び出し元 `PdfInputPanel.svelte` 側の型参照も追従させる必要がある）。
- 成功時のジョブ登録パターン（223-234行目）: `jobsStore.upsert()` → `sessionJobIds.add()` → `startPolling()`。`sourceType: "pdf"` の部分を `"txt"` に変えるだけでTXTにも適用可能——ただし `JobEntry.sourceType` 型の拡張が前提（§2.3）。
- `submitPdf` は `onProgress` コールバックと `displayTitle` 引数を持つ。TXTでも同じシグネチャで問題ない。

### 2.3 `jobs.svelte.ts` / `job-entry.ts` — JobEntry拡張の影響

- `JobSourceType`（`frontend/src/lib/job-entry.ts:6`）を `"url" | "pdf" | "txt"` に拡張。
- `migrateJobEntry`（24-62行目）: 新形式（`sourceType` が `"url"|"pdf"`）と旧形式（`sourceType` 無し、`url` 必須）の2分岐。**`sourceType === "txt"` を新形式の分岐条件に追加するだけで済む**（33行目の条件を `j.sourceType === "url" || j.sourceType === "pdf" || j.sourceType === "txt"` に変更）。旧形式（TXT機能実装前に保存された履歴）は元々 `sourceType` を持たないため、この変更による既存データへの悪影響は無い。
- `IN_FLIGHT`（`jobs.svelte.ts:12`）配列は `["queued", "rendering", "converting"]`。**`"preparing"` を追加する必要がある**（TXTジョブがpreparingフェーズ中にポーリング対象から漏れないようにするため。これを忘れるとTXTジョブのpreparing中に `poll()` のIN_FLIGHT判定（`convert.svelte.ts:297`）が「完了/失敗」と誤認して止まる）。
- `effectiveStatus`（`jobs.svelte.ts:77-83`）は `status === "completed"` のみを見るロジックなので `preparing` 追加の影響なし。

### 2.4 i18n（`frontend/src/lib/i18n.svelte.ts`）

- `Messages` インターフェース（10-191行目）と `I18N.ja`/`I18N.en`（194行目〜）が全文言。PDF系は `pdf_*` プレフィックスで統一されている（41-92行目のフィールド一覧）。**TXT用も `text_*` または `txt_*` プレフィックスで同様に追加**（命名はPDF側に倣い `pdf_` があるので `text_` を推奨——`txt_`より自然な英語）。
- `JobStatus`型（8行目）と `status: Record<JobStatus, string>`（105行目、288/468行目の実体）に **`"preparing"` を追加**必須（§0-5）。日本語「本文を組版中」・英語「Preparing text」は仕様書§19の表そのまま使える。
- `status()` オブジェクトのキー漏れは実行時エラーにはならない（`statusLabel`関数、602-605行目が `Object.hasOwn` でフォールバックする）が、UI上「preparing」という生の文字列がそのまま表示されてしまうため実質必須。

### 2.5 `server-error-text.ts` のマッピング方式

- `resolveServerErrorKey`（31-47行目）は文字列の完全一致または正規表現マッチで `ServerErrorKey` に解決する純粋関数。**TXT用エラー文言もこの表に追加する形で実装する**（仕様書§19.1の11個のエラー文言に対応する `text_err_*` キーを `Messages` に追加し、ここにマッピングを追記）。
- 重要な設計: この関数は `i18n.svelte.ts` 本体から分離されている理由が明記されている（コメント4-9行目）——Svelte 5 runesの `$state` を含むファイルは素のvitest環境でimportできないため。TXT用エラーテキストのユニットテストも `server-error-text.test.ts` と同様の構成（rune非依存）で書くこと。
- サーバー側TXTエラー文字列は `src/text-upload.ts`/`text-decode.ts`/`text-normalize.ts` 側で確定してから、ここに1:1でマッピングを追加する（PDF側の `uploadedPdfErrorMessage` の安定文字列がそのまま `resolveServerErrorKey` の判定対象になっている前例と同じ設計）。

### 2.6 既存のフォント選択UI（URL変換）

**結論: 存在しない。** `frontend/src/lib/i18n.svelte.ts:428`(および対応する日本語行248行目)の `pdf_advanced_note` が唯一のフォント関連文言で、「PDFは変更不可」という否定文のみ。URL変換フォーム（`ConvertForm.svelte`）にもフォント/レイアウト選択UIは無く、`submitUrl`（`convert.svelte.ts:126-166`）は常に `{url, mode:"extract"}` のみPOSTしている（layout/fontパラメータを一切送らない——サーバー側 `resolveRenderOptions` のデフォルト値のみが使われる）。**TXT用フォント選択欄・プリセットボタン（標準/小説・縦書き/大きな文字）は完全新規実装**。

### 2.7 テスト構成（vitest）

- `frontend/vitest.config.ts`: `test.include: ["test/**/*.test.ts"]` のみ。**プラグイン（`@sveltejs/vite-plugin-svelte`)は読み込まれていない** — これが `.svelte.ts`（rune使用ファイル)を直接importするテストが書けない理由（`server-error-text.ts`が分離されている理由と同じ）。
- 既存テストファイル: `frontend/test/{job-entry,pdf-dither,pdf-file-validate,pdf-options,pdf-page-range,pdf-preview,server-error-text}.test.ts`。TXT用は `text-options.test.ts`, `text-file-validate.test.ts`（クライアント側検証、仕様書§10.4相当）, `text-decode.test.ts`(フロント側デコード関数がある場合) 等を同構成で追加。rune非依存の純粋関数だけを対象にする設計を踏襲すること。
- ルートの `vitest.config.ts`（Worker側）も同様に `test/**/*.test.ts` のみ。`@cloudflare/vitest-pool-workers` を使うテスト(`test/pdf-upload.test.ts`等)はこの設定を継承。

---

## 3. ギャップ分析

### 3.1 仕様書のファイル構成案とコードの差異

仕様書§20のファイル構成案は概ねそのまま使えるが、以下の食い違いに注意:

| 仕様書の想定 | 実際 | 対応 |
|---|---|---|
| `src/text-upload.ts` 等5モジュール新設 | 現行 `src/pdf-upload.ts` は1ファイルにヘッダー検証・バリデーション・R2保存を集約(376行) | 仕様書どおり分割してよいが、PDF側の粒度（1ファイル集約）と揃えるなら `text-upload.ts` に統合し、`text-options.ts`/`text-decode.ts`/`text-normalize.ts`/`text-html.ts` は純粋ロジック用に分ける、程度が既存規約と整合的 |
| `frontend/src/components/FileDropZone.svelte` | 実在するのは `PdfDropZone.svelte` | §2.1参照。リネーム or 新設どちらかを選択。**リネームを推奨**（重複UI回避） |
| `frontend/src/lib/text-preview.ts` | 該当する既存モジュールなし（`pdf-preview.ts`はcanvas/ditherロジックでPDF専用） | 新規実装。528×792のDOMプレビューはcanvas不要（spec§10.7よりHTML+CSSのみ）なのでpdf-preview.tsの構造は参考にならない |
| `test/fixtures/*.txt` | 現状 `test/fixtures/` ディレクトリ自体が存在しない（要確認: `find`結果になし） | 新規作成必要 |

### 3.2 Workflow step構成の組み込み方針（§12.2-12.4 対 `workflow.ts`）

- 既存構造は「1つの `ConvertWorkflow.run()` 内で `source.kind` により分岐」（PDF: `runUploadedPdf` private method、URL: run()本体のインライン処理）。**TXTも同じパターンで `runTextSource` 相当のprivate methodを追加するのが既存規約と整合的**（`runUploadedPdf`, `workflow.ts:345-434`をテンプレートにする）。
- `intermediate/{jobId}/source.pdf` というキーは**URL変換の中間PDFとTXT変換の中間PDFで完全に同名衝突する**（`intermediatePdfKey`関数が両者で同じ生成規則）。これはjobId起点で名前空間が分かれているため実害はない（同一jobIdが同時にURLジョブとTXTジョブを兼ねることはない）が、コードレビュー時に「同じ関数を2つの意味で使っている」という点は明記しておくべき。
- prepare-textステップの出力（仕様書§12.3）は `{articleKey, fontsKey, detectedEncoding, characterCount, lineCount}`——これは既存の extract-content ステップの戻り値パターン（`workflow.ts:107-166`、`{articleKey, fontsKey}`)を拡張した形で自然に実装できる。Workflow step戻り値の1MiB上限（`workflow.ts:69`のコメント）にも余裕で収まる。

### 3.3 フォント関連: 候補リストとBIZ UDPGothic/BIZ UDMincho

- Google Fontsの「候補選択UI」は存在しない（§0-4, §2.6）。現行は完全自由入力＋`sanitizeFontFamily`によるASCII regexバリデーションのみ。
- BIZ UDPGothic（`src/fonts.ts:40`, `DEFAULT_FONT_FAMILY`）・BIZ UDMincho（`src/sitepresets.ts:33`, `AOZORA_DEFAULT_FONT_FAMILY`）は共に既存コードで使用中・`DUAL_WEIGHT_FAMILIES`（`src/fonts.ts:50`）に登録済みで400/700ウェイト対応。**TXTのデフォルトフォント（仕様書§6.2/§6.3）をそのまま流用でき、フォント取得経路（`buildInlineFontCss`, `src/fonts.ts:129-188`）も無改修で使い回せる**——TXTの本文全体を対象にcss2 API text=パラメータでサブセット取得すればよい（`prepareRenderInput`の`buildPrintInput`, `src/extract.ts:429-448`の呼び出しパターンがそのまま参考になる）。
- 仕様書§24 判断事項8「Google Fontsを自由入力と候補選択のどちらにするか」への回答: **現行コードは自由入力のみをサポートしており、候補選択UIをTXTだけに新設するのはURL変換との一貫性を損なう**。自由入力＋バリデーションを踏襲するのが最小差分。候補選択（プルダウン等)を追加する場合はUXの新規要素として別途スコープに入れること。

### 3.4 ビルド・テスト・デプロイ手順

- `npm test`（ルート、`package.json:11`）: `vitest run`。`npm run test --prefix frontend`: 同様。`npm run typecheck`: `tsc --noEmit`。`npm run check:frontend`: `svelte-check`。これらはPDF機能実装時から変化なし（想定通り）。
- R2 lifecycle: **新規ルール追加は不要**。TXTが使うキーは `input/{jobId}/source.txt`・`intermediate/{jobId}/{article.html,fonts.css,source.pdf}`・`jobs/{jobId}/output.xtc` の3プレフィックス全て、既存のprefix単位lifecycleルール（`expire-input-pdf input/`, `expire-intermediate-pdf intermediate/`, `expire-job-outputs jobs/`、いずれも1日、`claudedocs/deploy-guide.md:85-87`）で**既にカバーされている**（ルール名に`pdf`とあるがprefixベースなので拡張子非依存）。これはユーザー提供の前提知識と一致。
- デプロイスクリプト（`scripts/deploy.sh`）や `wrangler.jsonc` の `run_worker_first` パス一覧（139-162行目）に **`/jobs/text` を追加する必要はない**——既に `/jobs/*` が含まれている（154行目）ため新パスも自動的にWorker優先で処理される。

### 3.5 Container変更の要否（再掲、§0-3）

- タイトル: 変更不要（既存の `<title>`→PDFメタデータ→`X-Xtc-Title` 経路をそのまま使う）。
- 著者: XTCメタデータへの反映には `converter/app.py`（`config_with_title`, 191-203行目）と `converter/config-x3.toml`（16行目 `author` フィールド）の改修が必要。HTML本文への表示（`<p class="author">`)だけなら不要。**スコープ確認事項として実装着手前にユーザー/仕様意図を確認するか、Phase 2（組版設定）の範囲に著者のXTCメタデータ反映を含めるか決定すること**（仕様書§23 Phase 2に「タイトル・著者」とあるが、XTCメタデータへの反映まで含むかは§15.4の記述次第——§15.4は「著者名はHTML表示とXTCメタデータへ反映する」と明記しているため、**Container改修は必須**と解釈すべき）。

---

## 4. 未確定・要判断事項（実装前に決めること）

1. **`renderPdfFromHtml`非対応問題（§0-1）の解決方針**: 新関数追加 vs 既存関数の条件分岐拡張。新関数追加を推奨（回帰リスク最小）。
2. **workerd `TextDecoder("shift_jis")` を使うか、完全に `encoding-japanese` に倒すか（§0-2, §1.5)**: 現時点のworkerdの成熟度から、Worker側も純JS実装に倒すことを推奨。
3. **著者のXTCメタデータ反映のためのContainer改修（§0-3, §3.5）**: スコープに含めるか要確認。
4. **X-Text-Optionsヘッダー欠如時の挙動（§1.2）**: default fallback（PDF方式）か 400（仕様書文言の字義通り）か。
5. **TXTジョブの `preparing` フェーズ判定に使うR2プローブ設計（§1.4）**: `mapWithPhaseProbe`の拡張方法とプローブ回数（レイテンシ影響）。
6. **`PdfDropZone.svelte`のリネーム範囲（§2.1, §3.1）**: リネームか新規`FileDropZone`追加か。

---

## 5. 実装順序への補足（仕様書§23 Phase 1-6 との対応）

Phase 1（UTF-8最小経路）着手前に済ませておくべき調査/決定は上記§4の1・2・4・5。これらはPhase 1のコア経路（`/jobs/text` → R2保存 → UTF-8デコード → HTMLエスケープ → 横書き固定HTML → Browser Run → PDF→XTC → 後処理）の設計そのものに影響するため、Phase 1着手前に固めることを推奨する。Phase 3（Shift_JIS/CP932）着手時に§4-2の判断を先送りすると、Phase 1で書いたデコード層のインターフェースを作り直す可能性が高い。
