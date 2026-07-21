# html-to-xtc

URL を 1 つ POST すると、印刷用 CSS を適用して PDF 化し、Xteink X3 向けの XTC ファイルに変換して返す API + スマホ向け WebUI。Cloudflare Workers + Browser Run + Containers + R2 + Workflows で動く。

## アーキテクチャ

```text
URLを送信
  ↓
Cloudflare Worker
  ├─ URL検証（SSRF対策 + DoH事前解決）
  ├─ Browser RunでCSS適用
  ├─ PDF生成
  ├─ PDFをR2へ保存
  ↓
Cloudflare Container
  ├─ xtctoolでPDF→XTC
  ↓
Worker
  ├─ XTCをR2へ保存
  └─ ダウンロードURLを返す
```

- PDF/XTC のバイト列は Worker ↔ Container 間で直接送受信する（Workflow パスの PDF 送信は R2 からの stream。メモリに全量を置かない）。R2 への読み書きは Worker の binding に一元化し、Container には R2 クレデンシャルもユーザー入力 URL も渡さない。
- Container は固定プール名（`converter-0` / `converter-1`、`max_instances: 2` に対応）に jobId のハッシュで振り分け、ウォームインスタンスを再利用する。
- 変換設定は `converter/config-x3.toml`（528×792、1-bit xtg、日本語メタデータ）。
- PDF の最終ページに奥付（タイトル・サイト名・著者・URL・変換日時・個人利用の注記）を追加する（`src/pdf.ts` の `buildColophonScript`。addScriptTag による DOM 注入。ページの CSP でブロックされた場合は奥付なしで変換される）。
- 変換パイプラインとは別に、青空文庫の公式書誌カタログを 1 日 1 回 Cron で D1（`AOZORA_DB`）へ同期する（`src/catalog-workflow.ts` の `AozoraCatalogSyncWorkflow`）。`scheduled()` は Workflow を起動するだけで、ZIP 取得・CSV 解析・D1 投入は Workflow の各 step が担う。全書誌を新しい `generation` として投入・検証しきってから `active_generation` を 1 回の UPDATE で切り替えるため、検索側（`aozora_books_active` / `aozora_book_contributors_active` ビュー）が中途半端なデータを見ることはない。詳細は「青空文庫カタログ同期（D1）」を参照。同期した書誌は `GET /api/books` で検索でき、WebUI の「青空文庫から選択」ダイアログから一括変換できる。

## WebUI

`frontend/`（Vite + Svelte 5 の SPA、スマホファースト）をビルドした `frontend/dist` を Workers static assets として `/` で配信する。URL を入力すると `POST /jobs` → 数秒間隔のポーリングで進捗（待機中 → PDF 生成中 → XTC 変換中）を表示し、完了するとダウンロードリンクとプレビューボタンが出る。変換モードは「レイアウトを保持して変換する」チェックボックスで選び、**未チェック（既定）が本文抽出（extract）、チェックありがページ丸ごと（full）**。WebUI は常に `mode` を明示送信する（API 自体の `mode` 省略時既定は full のまま）。履歴はブラウザの localStorage に保存（最大 50 件。履歴が空の間は履歴エリア自体を表示しない。サーバー上のファイルは約 24 時間で自動削除される旨を表示）。変換中の表示はジョブごとの並行ポーリングで複数件を同時に追跡する（in-flight ＋直近の完了/失敗を上限 10 件で表示）。

**青空文庫から選択**: フォーム下のボタンからダイアログを開き、タイトル・作者名で書誌を検索（`GET /api/books`、350ms デバウンス）して最大 5 件を選択し、まとめて変換ジョブへ投入できる（各作品の XHTML 版 URL を `POST /jobs` へ送る。青空文庫 URL は自動で縦書き・明朝の専用パスに載る）。

**XTC プレビュー**: 生成済み XTC をブラウザ内でデコードしてモーダルダイアログ（ネイティブ `<dialog>`）の canvas に描画する。XTC コンテナ（48B ヘッダー + 16B/ページのインデックス）と 1-bit XTG フレーム（22B ヘッダー、行方向 MSB 詰め）のパーサーを WebUI 内に持ち、fetch した ArrayBuffer はジョブ ID キーでキャッシュ（上限 5 件）してページ送りで再取得しない。マジック・version・colorMode・compression が想定外のファイルはプレビューのみ無効化してダウンロードリンクは維持する（将来 xtctool の出力形式が変わった場合のフォールバック）。履歴の各行には ⋮ ボタンがあり、ポップオーバーメニュー（Popover API、非対応ブラウザはクラス切替にフォールバック）から XTC ダウンロード / プレビューを選べる。サービス概要・利用規約・クローラー情報・連絡先は `/about`（`frontend/public/about.html`、ビルドで dist へそのままコピーされる静的ページ）に掲示し、フッターからリンクする。

静的アセットの配信は Worker を通らず、エッジから直接配信される。

## 認証

認証は設けていない（一般公開）。API（`/convert` `/jobs` `/download`）・WebUI とも誰でも利用できる。悪用対策はレート制限（次節）と URL 検証（SSRF 対策）で行う。

## レート制限

変換を起動するエンドポイント（`POST /convert`・`POST /jobs`）は IP ごとに **1 時間あたり 50 件**（固定窓、Worker の var `RATE_LIMIT_PER_HOUR` で変更可）に制限する（`src/ratelimit.ts` / `src/ratelimiter.ts`）。IP は Cloudflare エッジが設定する `CF-Connecting-IP` から取り、IPv6 は /64 プレフィックス単位で数える（プレフィックス内でアドレスを回すすり抜け対策）。超過時は 429 + `Retry-After`（窓リセットまでの秒数）を返す。カウントは IP キーごとの Durable Object が保持し、DO 呼び出しが失敗した場合はブロックせず通す（validate.ts の DoH 障害時と同じ可用性優先）。GET 系（状態確認・ダウンロード）は対象外。

## API

### POST /jobs（推奨）

非同期変換ジョブを作成する。長いドキュメントはこちらを使う（xtctool 最大 600 秒）。

```json
{ "url": "https://example.com/article", "mode": "extract", "layout": "vertical", "font": "BIZ UDMincho" }
```

- `mode`（任意）: `"full"`（既定。ページを丸ごとレンダリング）または `"extract"`（本文抽出モード。`src/extract.ts` が通常 fetch + Readability で本文だけのクリーン HTML を作って変換する。抽出できないページは Browser Rendering の `content` アクションで再試行し、それでも駄目なら full と同じ丸ごとレンダリングに自動劣化する — 必ず何かしらの出力は得られる）。`"full"`/`"extract"` 以外は 400。
- `layout`（任意）: `"horizontal"`（横書き）または `"vertical"`（縦書き `writing-mode: vertical-rl`）。未指定・不正値は既定値へフェイルソフト（400 にはならない）。既定は horizontal、ただし**青空文庫の XHTML**（`https://www.aozora.gr.jp/cards/{6桁}/files/{n}_{m}.html`、`src/sitepresets.ts`）は vertical。
- `font`（任意）: Google Fonts のファミリー名をそのまま指定する文字列（例 `"BIZ UDMincho"`, `"Noto Serif JP"`, `"Zen Old Mincho"`）。英数字・スペース・ハイフンのみ・64 文字以内（それ以外は既定値へフェイルソフト）。既定は `BIZ UDPGothic`、青空文庫 URL では `BIZ UDMincho`。既定 2 書体は 400/700 の 2 ウェイトを取得し、それ以外のファミリーは regular のみ取得（css2 API は存在しないウェイトを含むリクエストを丸ごと拒否するため）。存在しないファミリー名や取得失敗時は変換を失敗させず、汎用フォールバック書体（horizontal は sans-serif、vertical は serif）で続行する。

青空文庫 URL は layout/font の既定値に加えて専用の前処理が入る（`src/aozora.ts`: Shift_JIS デコード・Readability バイパスで `div.main_text` を直接抽出・ルビ構造の保持・傍点の text-emphasis 置換・字下げ/地付きの論理プロパティ化・外字/挿絵 URL の絶対化・底本情報の付加）。明示的に `layout: "horizontal"` を指定すれば青空文庫でも横書きになる。逆に一般サイトへ `layout: "vertical"` を指定した縦書き変換も可能。

どちらのモードも lazy-load 画像への対策を持つ。extract は `src/printhtml.ts` の sanitize 時に lazy 属性を正規化する（プレースホルダ `src` の検出、`data-src`/`data-lazy-src`/`data-original` の `src` への昇格、`srcset` からの 528px 出力に適した候補選択、`loading="lazy"` の除去。昇格した URL も既存のスキーム検査を通る）。full は PDF 化前に注入するスクリプト（`src/pdf.ts` の `LAZY_IMAGE_SCRIPT`）で `loading=lazy` の eager 化・`data-src` 昇格・ページ全体の段階スクロール（6 秒上限）を行い、`waitForTimeout` で画像読み込みの猶予を取る（ページの CSP でスクリプトが遮断された場合は従来同等の出力に劣化）。`<picture>/<source>` のみに実 URL を持つパターンは extract では救済できない（既知の制限）。

成功時 202:

```json
{ "jobId": "<uuid>", "statusUrl": "/jobs/<uuid>" }
```

| ステータス | 意味 |
|---|---|
| 400 | body が JSON でない / `url` 欠落 / `mode` 不正 / URL 検証エラー（/convert と同じ） |
| 429 | IP ごとのレート制限超過（`Retry-After` ヘッダ付き） |
| 500 | Workflow インスタンス作成失敗 |

裏側は Cloudflare Workflows（extract モード時のみ extract-content → 以降は常に render-pdf → convert-xtc → delete-intermediate-pdf）。render / convert は失敗時にそのステップだけ再試行される（render: 2 回 / convert: 2 回。PDF サイズ超過などの恒久エラーは再試行なしで failed）。extract-content は抽出失敗を throw せず full 劣化で吸収する（抽出 HTML は R2 の `intermediate/{jobId}/article.html` 経由で受け渡し。ステップ出力 1 MiB 制限のため）。最後のステップは変換の成否にかかわらず中間 PDF（と抽出 HTML）を即削除する（best-effort）。

### GET /jobs/{jobId}

ジョブ状態を返す。ポーリングして `completed` を待つ。

```json
{ "jobId": "<uuid>", "status": "converting" }
```

- `status`: `queued` → `rendering` → `converting` → `completed` | `failed`
- `completed` 時は `downloadUrl`（`/jobs/{jobId}/download`）付き、`failed` 時は `error`（メッセージ）付き。
- `rendering`/`converting` の区別は R2 上の中間 PDF（`intermediate/{jobId}/source.pdf`）の有無から導出する（Workflows の status() は実行中ステップ名を返さないため）。
- jobId が UUID 形式でなければ 400、不明・Workflows インスタンスの保持期限切れ（`retention` 指定により成功・失敗とも約 1 日）なら 404。なお成果物 XTC 自体は R2 lifecycle により約 24 時間で削除される（ダウンロード側で 404）。

### GET /jobs/{jobId}/download

R2 上の XTC（`jobs/{jobId}/output.xtc`）を attachment で返す。未完了なら 409 + `{status}`、不明 jobId・成果物期限切れ（約 24 時間）・失敗ジョブなら 404。

### POST /convert（短ページ用・非推奨。/jobs 推奨）

```json
{ "url": "https://example.com/article", "mode": "extract" }
```

`mode` / `layout` / `font` は POST /jobs と同じ（いずれも任意。`mode` の既定は `"full"`、`layout`/`font` は URL に応じた既定値へ解決）。

成功時 200:

```json
{ "jobId": "<uuid>", "downloadUrl": "/download/<uuid>" }
```

| ステータス | 意味 |
|---|---|
| 400 | body が JSON でない / `url` 欠落 / URL 検証エラー（スキーム・禁止 IP・DoH 解決結果が禁止レンジまたは解決 IP 0 件） |
| 405 | メソッド不一致（`Allow` ヘッダ付き） |
| 422 | 生成 PDF がサイズ上限超過、または xtctool の変換失敗 |
| 429 | IP ごとのレート制限超過（`Retry-After` ヘッダ付き） |
| 500 | R2 書き込み失敗などの内部エラー |
| 502 | Browser Run の PDF 生成失敗、または Container に到達できない |

エラーレスポンスは汎用メッセージ + jobId のみ。上流の詳細（Browser Run のエラー本文、xtctool の stderr）はログにのみ記録される。診断用の中間 PDF（`intermediate/{jobId}/source.pdf`）は変換の成否にかかわらず処理後に即削除する（best-effort。削除に失敗しても R2 lifecycle により約 1 日で自動削除される）。

同期 API のため、Container fetch 全体で 150 秒のタイムアウト内に収まる必要がある（xtctool 自体は 600 秒まで動けるが、同期パスは短ページ向けに 150 秒で打ち切る）。長いドキュメントは POST /jobs を使うこと。

### GET /api/books

同期済みの青空文庫書誌カタログ（D1 の `aozora_books_active` ビュー）を検索する。

```
GET /api/books?q=<検索語>&limit=<1..50 省略時 50>
```

- `q` はタイトル・作者名のどちらでもよい。NFKC・小文字化・カタカナ→ひらがな・記号/空白除去の正規化を通してから、`search_text` の部分一致で検索する（タイトル前方一致 > 作者名前方一致の順に整列）。`q` が空（正規化後に空になる場合を含む）は `{"books": []}` を返す。
- XHTML 版 URL（`htmlUrl`）を持たない作品（全体の約 0.5%、本文がなく変換不能）は結果から除外する。
- 応答例: `{"books": [{"workId": "000773", "title": "こころ", "subtitle": null, "author": "夏目 漱石", "htmlUrl": "https://...", "cardUrl": "https://...", "copyrighted": false}]}`
- `Cache-Control: public, max-age=300`。レート制限の対象外（変換を起動しない読み取りのため。重い操作は `POST /jobs` 側で制限済み）。

### GET /download/{jobId}

R2 上の XTC を `application/octet-stream` + `Content-Length` + `Content-Disposition: attachment; filename="{jobId}.xtc"` で返す。jobId が UUID 形式でなければ 400、未生成なら 404。

## サイズ・同時実行の上限

| 項目 | 既定値 | 変更方法 |
|---|---|---|
| 生成 PDF の上限（Worker） | 48 MiB（`wrangler.jsonc` の var `MAX_PDF_BYTES`。コード上の既定は 20 MiB） | Worker の var `MAX_PDF_BYTES`（バイト数） |
| 受信 PDF の上限（Container） | 50 MiB | Container の env `MAX_PDF_BYTES`（超過は 413） |
| xtctool タイムアウト | 600 秒 | Container の env `XTC_TIMEOUT_SECONDS`（`src/container.ts` の `envVars` で設定） |
| 同時変換数（Container 内） | 2 | Container の env `MAX_CONCURRENT_CONVERSIONS`（Semaphore で制限） |
| 変換リクエストのレート制限（IP ごと・1 時間固定窓） | 50 件 | Worker の var `RATE_LIMIT_PER_HOUR`（「レート制限」参照） |

## 青空文庫カタログ同期（D1）

青空文庫の公式書誌 CSV（「公開中 作家別作品一覧拡充版：全て」UTF-8・zip）を 1 日 1 回取得し、`html2xtc` から検索可能な形で D1（binding `AOZORA_DB`、DB 名 `html2xtc-aozora-catalog`）へ保存する。書誌検索 API（`GET /api/books`、「API」の節を参照）と WebUI（「青空文庫から選択」ダイアログ）も実装済み。

- **起動**: Cron Trigger（`wrangler.jsonc` の `triggers.crons`）で `scheduled()` を叩き、`AOZORA_SYNC_WORKFLOW` を起動する。Cron は UTC 指定で、既定は `30 18 * * *`（= 03:30 JST）の 1 日 1 回。同期のたびに青空文庫へアクセスするのは ZIP 1 ファイルのみ。
- **未変更検出**: 保存済みの `ETag` / `Last-Modified` で条件付き GET し、304 か、本文の SHA-256 が前回と同じなら投入せず `unchanged` で終了する。
- **世代管理**: 全書誌に `generation`（例 `20260720T183000Z-<sha12>`）を付けて投入し、件数・図書カード URL 保有率などの検証を通過してから `aozora_catalog_state.active_generation` を 1 回の UPDATE で切り替える。切り替え後に旧世代を削除する。検索側はテーブルではなくビュー（`aozora_books_active` / `aozora_book_contributors_active`）を読むため、投入途中のデータや切り替え失敗が結果に混ざらない。
- **重い処理の分割**: ZIP 展開・CSV 解析結果は R2（既存の `XTC_BUCKET`、キー接頭辞 `aozora-sync/<runId>/`）へ小さな JSON チャンク（200 行/チャンク）として置き、Workflow の各 step でチャンク単位に D1 へ UPSERT する。step の戻り値は小さなメタデータのみ（1 MiB 上限）。同期中間ファイルは切り替え後に削除する。
- **ロック**: `aozora_catalog_state` の 1 行を条件付き UPDATE で排他ロックし、二重同期を防ぐ。ロックには有効期限（既定 120 分）があり、step が強制終了してもロックが残り続けない。
- **ID の保持**: 作品 ID・人物 ID はゼロ埋め（例 `000773`）のため、先頭ゼロを失わないよう D1 では TEXT で保持する。列はヘッダー名で参照し、公式 CSV の列追加・並び替えに耐える（必須ヘッダー欠損時は同期を失敗させる）。
- **履歴**: 各同期の状態（`running` / `unchanged` / `completed` / `failed` / `skipped_locked`）・件数・エラーは `aozora_catalog_sync_runs` に記録する。現フェーズでは同期状態を返す公開 API は設けない。
- **依存**: ZIP 展開に `fflate`、CSV 解析に `papaparse`（いずれも純 JS。`nodejs_compat` は不要）。純粋ロジック（正規化・集約・チャンク分割・検証）は `src/catalog.ts` に分離し `test/catalog.test.ts` でテストする。D1 操作は `src/catalog-db.ts`、R2 キー生成は `src/catalog-keys.ts`。

D1 の作成・migration 適用は「ローカル開発」を参照。

## URL 検証（SSRF 対策）と既知の限界

`src/validate.ts`。

- http/https 以外のスキーム、localhost 系ホスト名を拒否。
- 自サービスのホスト（`xtc.hr20k.com`、および `*.workers.dev` 全体。デプロイホスト `url-to-xtc.<subdomain>.workers.dev` を含む）も拒否し、自分自身への再帰変換を防ぐ。
- IP リテラルの禁止レンジ: 0/8, 10/8, 100.64/10（CGNAT）, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, ::/128, ::1, fc00::/7, fe80::/10。IPv4 埋め込み IPv6（IPv4-mapped `::ffff:0:0/96`、IPv4-compatible `::/96`、6to4 `2002::/16`、NAT64 `64:ff9b::/96`）は埋め込み IPv4 を同じ判定にかける。
- IP リテラル以外のホスト名は Cloudflare DoH（`cloudflare-dns.com/dns-query`）で A/AAAA を事前解決し、解決結果 IP を同じ禁止判定にかける。A/AAAA は個別に判定し（`Promise.allSettled`）、**片方のクエリが失敗しても、成功した側の解決 IP は必ず禁止判定にかける**。DoH の HTTP エラーだけでなく DNS RCODE≠0（SERVFAIL・REFUSED 等）もクエリ失敗として扱う。両クエリとも NOERROR で成功したのに解決 IP が 0 件の場合（スプリットホライズンの内部名など。Cloudflare DoH は CNAME を最終 A/AAAA までフラット化するため、正当な公開ホストでは起きない）は**拒否**（フェイルクローズ）。**両クエリとも失敗した場合のみブロックせず通す**（可用性優先。Browser Run 側でも解決されるため）。片方だけ成功して 0 件のときも DoH 障害の可能性があるため通す。

**既知の限界:**

- TOCTOU / DNS リバインディング: DoH の事前解決と Browser Run 側の実解決は別クエリのため、リバインディング DNS はすり抜けられる。
- DoH 失敗時の素通し: 両クエリ失敗時、および片方成功（解決 0 件）＋片方失敗時は無検査で通す。この partial-failure 経路は自ドメインの権威 DNS を制御する攻撃者が意図的に再現できるが、両クエリ失敗時の素通しと同レベルの受容済みリスク（可用性優先）。
- リダイレクト先の再検証: quickAction の API では制御できない。

## 名乗る User-Agent

Browser Run での対象ページ取得時は `xtc-converter/1.0 (+https://xtc.hr20k.com/about)` を名乗る（`src/pdf.ts` の `RENDER_USER_AGENT`）。Googlebot 方式の `+URL` 慣習で、サイト管理者はアクセスログの UA からこのサービスを識別して UA 単位でブロックでき、URL 先の `/about` で利用規約・連絡先を確認できる。

## ローカル開発

前提: Node.js、Docker（Container イメージのビルドに必要）、Cloudflare は Workers Paid プラン（Browser Run / Containers に必須）。

```sh
npm install

# 型チェック
npx tsc --noEmit

# Worker 側テスト（URL 検証。DoH はモック）
npx vitest run

# Container 側テスト（xtctool は呼ばずモック）
python3 -m venv .venv && .venv/bin/pip install pytest   # 初回のみ
.venv/bin/python -m pytest test/converter/

# Container イメージのビルド確認（linux/amd64 必須）
docker build --platform linux/amd64 -f converter/Dockerfile converter/

# フロントエンドのビルド（初回は npm install も必要）。
# wrangler.jsonc の assets.directory が frontend/dist（gitignore 済み）を指すため、
# 未ビルドのまま npx wrangler dev を実行すると起動に失敗する。
npm install --prefix frontend
npm run build --prefix frontend

# 青空文庫カタログ用 D1 の作成（初回のみ。出力の database_id を
# wrangler.jsonc の d1_databases[].database_id へ設定する）
npx wrangler d1 create html2xtc-aozora-catalog

# migration の適用（マイグレーションは migrations/aozora 配下）
npx wrangler d1 migrations apply html2xtc-aozora-catalog --local    # ローカル
npx wrangler d1 migrations apply html2xtc-aozora-catalog --remote   # 本番（デプロイ時）

# 適用確認（singleton state 行が 1 行できる）
npx wrangler d1 execute html2xtc-aozora-catalog --local \
  --command "SELECT * FROM aozora_catalog_state"

# Cron（青空文庫カタログ同期）のローカル起動確認
npx wrangler dev
# 別ターミナルで:
# curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=30+18+*+*+*&format=json"

# ローカル実行（Browser Run は remote:true のため Cloudflare 認証が必要）
npx wrangler dev

# デプロイ（Docker デーモン起動が必要。イメージが自動 build & push される）
npm run deploy
```

フロントエンド（`frontend/`、Vite + Svelte 5）の開発は `npm install --prefix frontend` 後に `npm run dev:frontend` で Vite dev サーバーを起動する。`/convert` `/jobs` `/download` `/version.json` は `http://localhost:8787`（`npx wrangler dev`）へプロキシされるので、Worker を並行起動すれば実 API で動作確認できる。型チェックは `npm run check:frontend`（svelte-check）、本番ビルドは `npm run build:frontend`（`frontend/dist` に出力。デプロイ時は scripts/deploy.sh が自動でビルドする）。

デプロイは必ず `npm run deploy`（[scripts/deploy.sh](scripts/deploy.sh)）で行う。作業ツリーがクリーンで HEAD が origin/main に push 済みであることを検証したうえで、フロントエンドをビルド（`npm ci --prefix frontend && npm run build --prefix frontend`）し、稼働コミットを WebUI フッターに表示するための `frontend/dist/version.json`（dist ごと gitignore 済み）を生成してから `wrangler deploy` を実行し、成功時に `deploy-<UTC日時>-<短縮コミットハッシュ>` の Git タグを自動作成・push する。AGPL-3.0 対応として「デプロイごとに対応する Git タグを記録する」運用は、このスクリプトで自動化されている。`wrangler deploy` の直叩きはしないこと。

## ライセンス

本リポジトリのコードは [GNU AGPL-3.0-or-later](LICENSE)。本プロジェクトは **Xteink 社とは無関係な非公式ツール**であり、権利者の承認・提携・保証を受けていない。

変換に使う [xtctool](https://github.com/chazeon/xtctool)（GPL-3.0 として扱う）と PyMuPDF（AGPL-3.0 / 商用デュアル）はリポジトリに含まれず、Docker ビルド時に取得する。`converter/app.py` が PyMuPDF を直接 import するため、権利者 Artifex の示す保守的な解釈（サーバーアプリケーションに組み込む場合はアプリケーション全体のソースを AGPL で開示する）に沿い、リポジトリ全体を AGPL-3.0-or-later で公開している。使用コミット・ビルド時に加えている変更・配布時の義務は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。**Docker イメージを第三者へ配布する場合は同ファイル記載の GPL/AGPL 対応が必要。**

このコードをネットワーク越しのサービスとして稼働させる場合、AGPL-3.0 第 13 条により、サービスの利用者に対して「稼働中のバージョンに対応するソースコード」を提供する必要がある（本デプロイでは WebUI フッターの GitHub リンクがこれに当たる）。稼働版とソースの対応関係を明確にするため、デプロイのたびに対応する Git タグ（または commit ハッシュ）を記録し、公開リポジトリの当該リビジョンがそのまま稼働版のソースとなるように運用する。このタグ記録は `npm run deploy`（[scripts/deploy.sh](scripts/deploy.sh)）が自動で行う（クリーンツリー・origin/main push 済みを検証のうえ、フロントエンドをビルドし、稼働コミットを記した `frontend/dist/version.json` を生成してデプロイし、`deploy-<UTC日時>-<短縮コミットハッシュ>` タグを作成・push。詳細は「使い方」のデプロイ手順を参照）。WebUI フッターは `/version.json` を読み取り、稼働中の commit と当該リビジョンへの GitHub リンクを表示する。

Container イメージの Python 依存（xtctool の推移的依存を含む）は [converter/requirements.lock](converter/requirements.lock) でバージョン・ハッシュとも完全固定しており、同じ Git リビジョンから再ビルドすれば稼働版と同一バージョンの依存構成が再現される（対応ソースの再現性確保。更新手順は同ファイルのヘッダーコメントを参照）。なおビルド時依存（hatchling 等の build-system.requires）は固定対象外。

## 補足

- Container イメージは xtctool を検証済み commit（`d7bff34`、2026-07-17 検証）に固定し、非 root ユーザー（uid 10001）で実行する。
- `converter/config-x3.toml` の `resample_method` は BOX（テキスト向き）。写真主体のページが多い場合は LANCZOS に変更する。
- XTC 出力サイズの目安は約 51KB/ページ（1-bit xtg、無圧縮）。
