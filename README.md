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

## WebUI

`public/index.html`（依存なしの 1 ページ、スマホファースト）を Workers static assets として `/` で配信する。URL を入力すると `POST /jobs` → 数秒間隔のポーリングで進捗（待機中 → PDF 生成中 → XTC 変換中）を表示し、完了するとダウンロードリンクとプレビューボタンが出る。変換モードは「レイアウトを保持して変換する」チェックボックスで選び、**未チェック（既定）が本文抽出（extract）、チェックありがページ丸ごと（full）**。WebUI は常に `mode` を明示送信する（API 自体の `mode` 省略時既定は full のまま）。履歴はブラウザの localStorage に保存（最大 50 件。サーバー上のファイルは約 24 時間で自動削除される旨を表示）。

**XTC プレビュー**: 生成済み XTC をブラウザ内でデコードしてモーダルダイアログ（ネイティブ `<dialog>`）の canvas に描画する。XTC コンテナ（48B ヘッダー + 16B/ページのインデックス）と 1-bit XTG フレーム（22B ヘッダー、行方向 MSB 詰め）のパーサーを WebUI 内に持ち、fetch した ArrayBuffer はジョブ ID キーでキャッシュ（上限 5 件）してページ送りで再取得しない。マジック・version・colorMode・compression が想定外のファイルはプレビューのみ無効化してダウンロードリンクは維持する（将来 xtctool の出力形式が変わった場合のフォールバック）。履歴の各行には ⋮ ボタンがあり、ポップオーバーメニュー（Popover API、非対応ブラウザはクラス切替にフォールバック）から XTC ダウンロード / プレビューを選べる。サービス概要・利用規約・クローラー情報・連絡先は `/about`（`public/about.html`、静的配信）に掲示し、フッターからリンクする。

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

# ローカル実行（Browser Run は remote:true のため Cloudflare 認証が必要）
npx wrangler dev

# デプロイ（Docker デーモン起動が必要。イメージが自動 build & push される）
npm run deploy
```

デプロイは必ず `npm run deploy`（[scripts/deploy.sh](scripts/deploy.sh)）で行う。作業ツリーがクリーンで HEAD が origin/main に push 済みであることを検証したうえで、稼働コミットを WebUI フッターに表示するための `public/version.json`（gitignore 済み）を生成してから `wrangler deploy` を実行し、成功時に `deploy-<UTC日時>-<短縮コミットハッシュ>` の Git タグを自動作成・push する。AGPL-3.0 対応として「デプロイごとに対応する Git タグを記録する」運用は、このスクリプトで自動化されている。`wrangler deploy` の直叩きはしないこと。

## 構成ファイル

```
public/
  index.html     スマホ向け WebUI（vanilla 1 ページ、Workers static assets で配信。XTC プレビューのデコーダ含む）
  about.html     サービス概要・利用規約・クローラー情報・連絡先（/about、静的配信）
src/
  index.ts       ルーティング・エラーハンドリング
  workflow.ts    ConvertWorkflow（[extract-content →] render-pdf → convert-xtc → delete-intermediate-pdf）
  jobs.ts        ジョブ状態写像・R2 キー導出・上限解決（純関数、vitest 対象）
  pdf.ts         印刷 CSS 生成（layout/font オプション駆動、横書き/縦書き）+ Browser Run quickAction("pdf") 呼び出し（LAZY_IMAGE_SCRIPT・奥付注入含む）
  extract.ts     extract モードの本文抽出（Readability + Browser Rendering フォールバック）
  aozora.ts      青空文庫 XHTML 専用の前処理（main_text 抽出・ルビ保持・傍点/字下げ CSS）
  sitepresets.ts サイト別デフォルト解決（青空文庫 URL 判定 → vertical + BIZ UDMincho）
  printhtml.ts   抽出本文の印刷用 HTML 生成・sanitize（lazy 画像正規化含む、vitest 対象）
  pipeline.ts    XTC 出力の R2 保存などモード共通処理
  fonts.ts       PDF 本文フォントのサブセット取得・インライン化（ファミリー名は font オプションで可変、既定 BIZ UDPGothic）
  container.ts   XtcConverterContainer + convertInContainer（@cloudflare/containers）
  ratelimit.ts   レート制限の純関数（IP キー正規化・固定窓判定、vitest 対象）
  ratelimiter.ts RateLimiter Durable Object + enforceRateLimit（429 応答）
  validate.ts    SSRF 対策の URL 検証（DoH 事前解決含む）
  types.ts       Env 型・ConvertJobParams
converter/
  Dockerfile     マルチステージ（builder で xtctool を venv へ）+ 非 root 実行
  app.py         POST /convert（PDF bytes → XTC bytes）/ GET /healthz
                 graceful shutdown（SIGTERM でドレイン）、同時変換制限付き
  config-x3.toml X3 用変換設定
test/
  validate.test.ts        vitest
  jobs.test.ts            vitest（状態写像・キー導出の単体テスト）
  pdf.test.ts             vitest（印刷 CSS・quickAction オプションのピン留め）
  extract.test.ts         vitest（本文抽出）
  printhtml.test.ts       vitest（sanitize・lazy 画像正規化）
  fonts.test.ts           vitest
  aozora.test.ts          vitest（青空文庫抽出・オプション解決・縦書き CSS のピン留め）
  ratelimit.test.ts       vitest（IP キー正規化・固定窓判定・上限パース）
  converter/test_app.py   pytest
```

## ライセンス

本リポジトリのコードは [GNU AGPL-3.0-or-later](LICENSE)。本プロジェクトは **Xteink 社とは無関係な非公式ツール**であり、権利者の承認・提携・保証を受けていない。

変換に使う [xtctool](https://github.com/chazeon/xtctool)（GPL-3.0 として扱う）と PyMuPDF（AGPL-3.0 / 商用デュアル）はリポジトリに含まれず、Docker ビルド時に取得する。`converter/app.py` が PyMuPDF を直接 import するため、権利者 Artifex の示す保守的な解釈（サーバーアプリケーションに組み込む場合はアプリケーション全体のソースを AGPL で開示する）に沿い、リポジトリ全体を AGPL-3.0-or-later で公開している。使用コミット・ビルド時に加えている変更・配布時の義務は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。**Docker イメージを第三者へ配布する場合は同ファイル記載の GPL/AGPL 対応が必要。**

このコードをネットワーク越しのサービスとして稼働させる場合、AGPL-3.0 第 13 条により、サービスの利用者に対して「稼働中のバージョンに対応するソースコード」を提供する必要がある（本デプロイでは WebUI フッターの GitHub リンクがこれに当たる）。稼働版とソースの対応関係を明確にするため、デプロイのたびに対応する Git タグ（または commit ハッシュ）を記録し、公開リポジトリの当該リビジョンがそのまま稼働版のソースとなるように運用する。このタグ記録は `npm run deploy`（[scripts/deploy.sh](scripts/deploy.sh)）が自動で行う（クリーンツリー・origin/main push 済みを検証のうえ、稼働コミットを記した `public/version.json` を生成してデプロイし、`deploy-<UTC日時>-<短縮コミットハッシュ>` タグを作成・push。詳細は「使い方」のデプロイ手順を参照）。WebUI フッターは `/version.json` を読み取り、稼働中の commit と当該リビジョンへの GitHub リンクを表示する。

Container イメージの Python 依存（xtctool の推移的依存を含む）は [converter/requirements.lock](converter/requirements.lock) でバージョン・ハッシュとも完全固定しており、同じ Git リビジョンから再ビルドすれば稼働版と同一バージョンの依存構成が再現される（対応ソースの再現性確保。更新手順は同ファイルのヘッダーコメントを参照）。なおビルド時依存（hatchling 等の build-system.requires）は固定対象外。

## 補足

- Container イメージは xtctool を検証済み commit（`d7bff34`、2026-07-17 検証）に固定し、非 root ユーザー（uid 10001）で実行する。
- `converter/config-x3.toml` の `resample_method` は BOX（テキスト向き）。写真主体のページが多い場合は LANCZOS に変更する。
- XTC 出力サイズの目安は約 51KB/ページ（1-bit xtg、無圧縮）。
