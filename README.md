# html-to-xtc

URL を 1 つ POST すると、印刷用 CSS を適用して PDF 化し、Xteink X3 向けの XTC ファイルに変換して返す API + スマホ向け WebUI。Cloudflare Workers + Browser Run + Containers + R2 + Workflows で動く。Phase 4（WebUI・Cloudflare Access 対応）。

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

- PDF/XTC のバイト列は Worker ↔ Container 間で直接送受信する。R2 への読み書きは Worker の binding に一元化し、Container には R2 クレデンシャルもユーザー入力 URL も渡さない。
- Container は固定プール名（`converter-0` / `converter-1`、`max_instances: 2` に対応）に jobId のハッシュで振り分け、ウォームインスタンスを再利用する。
- 変換設定は `converter/config-x3.toml`（528×792、4 階調 xth、日本語メタデータ）。

## WebUI

`public/index.html`（依存なしの 1 ページ、スマホファースト）を Workers static assets として `/` で配信する。URL を入力すると `POST /jobs` → 数秒間隔のポーリングで進捗（待機中 → PDF 生成中 → XTC 変換中）を表示し、完了するとダウンロードリンクが出る。履歴はブラウザの localStorage に保存（最大 50 件。サーバー上のファイルは約 30 日で自動削除される旨を表示）。

静的アセットの配信は Worker を通らないため、UI の保護はエッジ側の **Cloudflare Access**（workers.dev のワンクリック有効化）が前提。設定手順は claudedocs/deploy-guide.md の「Phase 4」を参照。

## 認証

API（`/convert` `/jobs` `/download`）は次の **OR** で通す（`src/auth.ts`）:

- **Cloudflare Access JWT**: vars `ACCESS_TEAM_DOMAIN` と `ACCESS_POLICY_AUD` を両方設定したときのみ有効。`Cf-Access-Jwt-Assertion` ヘッダ（フォールバックで `CF_Authorization` クッキー）の JWT を jose で検証する。ブラウザは Access ログイン、CLI は Access service token（`CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダ）で通る。
- **Bearer トークン**: `AUTH_TOKEN` secret（`wrangler secret put AUTH_TOKEN`）を設定すると `Authorization: Bearer <token>` を検証（不一致は 401）。ローカル開発・Access を使わない構成向け。

両方とも未設定の場合は認証なしで通す（ローカル開発用）。**本番デプロイでは Cloudflare Access で保護するか、AUTH_TOKEN の設定が必須。** なお Access をエッジで有効化すると、素の Bearer だけのリクエストはエッジで遮断されるため CLI は service token が必要（deploy-guide 参照）。

## API

### POST /jobs（推奨）

非同期変換ジョブを作成する。長いドキュメントはこちらを使う（xtctool 最大 600 秒）。

```json
{ "url": "https://example.com/article" }
```

成功時 202:

```json
{ "jobId": "<uuid>", "statusUrl": "/jobs/<uuid>" }
```

| ステータス | 意味 |
|---|---|
| 400 | body が JSON でない / `url` 欠落 / URL 検証エラー（/convert と同じ） |
| 401 | AUTH_TOKEN 設定時、Bearer トークン欠落・不一致 |
| 500 | Workflow インスタンス作成失敗 |

裏側は Cloudflare Workflows の 2 ステップ（render-pdf → convert-xtc）。各ステップは失敗時にそのステップだけ再試行される（render: 2 回 / convert: 2 回。PDF サイズ超過などの恒久エラーは再試行なしで failed）。

### GET /jobs/{jobId}

ジョブ状態を返す。ポーリングして `completed` を待つ。

```json
{ "jobId": "<uuid>", "status": "converting" }
```

- `status`: `queued` → `rendering` → `converting` → `completed` | `failed`
- `completed` 時は `downloadUrl`（`/jobs/{jobId}/download`）付き、`failed` 時は `error`（メッセージ）付き。
- `rendering`/`converting` の区別は R2 上の中間 PDF（`intermediate/{jobId}/source.pdf`）の有無から導出する（Workflows の status() は実行中ステップ名を返さないため）。
- jobId が UUID 形式でなければ 400、不明・保持期限切れ（30 日）なら 404。

### GET /jobs/{jobId}/download

R2 上の XTC（`jobs/{jobId}/output.xtc`）を attachment で返す。未完了なら 409 + `{status}`、不明 jobId・成果物期限切れ・失敗ジョブなら 404。

### POST /convert（短ページ用・非推奨。/jobs 推奨）

```json
{ "url": "https://example.com/article" }
```

成功時 200:

```json
{ "jobId": "<uuid>", "downloadUrl": "/download/<uuid>" }
```

| ステータス | 意味 |
|---|---|
| 400 | body が JSON でない / `url` 欠落 / URL 検証エラー（スキーム・禁止 IP・DoH 解決結果が禁止レンジ） |
| 401 | AUTH_TOKEN 設定時、Bearer トークン欠落・不一致 |
| 405 | メソッド不一致（`Allow` ヘッダ付き） |
| 422 | 生成 PDF がサイズ上限超過、または xtctool の変換失敗 |
| 500 | R2 書き込み失敗などの内部エラー |
| 502 | Browser Run の PDF 生成失敗、または Container に到達できない |

エラーレスポンスは汎用メッセージ + jobId のみ。上流の詳細（Browser Run のエラー本文、xtctool の stderr）はログにのみ記録される。変換失敗時は中間 PDF（source.pdf）を R2 から削除する（best-effort）。診断用の中間 PDF は Phase 2 で `intermediate/{jobId}/source.pdf` に移り、R2 lifecycle により約 1 日で自動削除される。

同期 API のため、Container fetch 全体で 150 秒のタイムアウト内に収まる必要がある（xtctool 自体は 600 秒まで動けるが、同期パスは短ページ向けに 150 秒で打ち切る）。長いドキュメントは POST /jobs を使うこと。

### GET /download/{jobId}

R2 上の XTC を `application/octet-stream` + `Content-Length` + `Content-Disposition: attachment; filename="{jobId}.xtc"` で返す。jobId が UUID 形式でなければ 400、未生成なら 404。

## サイズ・同時実行の上限

| 項目 | 既定値 | 変更方法 |
|---|---|---|
| 生成 PDF の上限（Worker） | 20 MiB | Worker の var `MAX_PDF_BYTES`（バイト数） |
| 受信 PDF の上限（Container） | 50 MiB | Container の env `MAX_PDF_BYTES`（超過は 413） |
| xtctool タイムアウト | 600 秒 | Container の env `XTC_TIMEOUT_SECONDS`（`src/container.ts` の `envVars` で設定） |
| 同時変換数（Container 内） | 2 | Container の env `MAX_CONCURRENT_CONVERSIONS`（Semaphore で制限） |

## URL 検証（SSRF 対策）と既知の限界

`src/validate.ts`。

- http/https 以外のスキーム、localhost 系ホスト名を拒否。
- IP リテラルの禁止レンジ: 0/8, 10/8, 100.64/10（CGNAT）, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, ::/128, ::1, fc00::/7, fe80::/10。IPv4 埋め込み IPv6（IPv4-mapped `::ffff:0:0/96`、IPv4-compatible `::/96`、6to4 `2002::/16`、NAT64 `64:ff9b::/96`）は埋め込み IPv4 を同じ判定にかける。
- IP リテラル以外のホスト名は Cloudflare DoH（`cloudflare-dns.com/dns-query`）で A/AAAA を事前解決し、解決結果 IP を同じ禁止判定にかける。**DoH 障害時はブロックせず通す**（可用性優先。Browser Run 側でも解決されるため）。

**既知の限界（Phase 1 では未対応、README とコードコメントに明記）:**

- TOCTOU / DNS リバインディング: DoH の事前解決と Browser Run 側の実解決は別クエリのため、リバインディング DNS はすり抜けられる。
- リダイレクト先の再検証: quickAction の API では制御できない（Phase 2 検討事項）。

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
npx wrangler secret put AUTH_TOKEN   # 本番は必須（または Cloudflare Access）
npx wrangler deploy
```

## 構成ファイル

```
public/
  index.html     スマホ向け WebUI（vanilla 1 ページ、Workers static assets で配信）
src/
  index.ts       ルーティング・エラーハンドリング
  auth.ts        認証（Access JWT または Bearer AUTH_TOKEN の OR）
  workflow.ts    ConvertWorkflow（render-pdf → convert-xtc の 2 ステップ）
  jobs.ts        ジョブ状態写像・R2 キー導出（純関数、vitest 対象）
  pdf.ts         X3_PRINT_CSS + Browser Run quickAction("pdf") 呼び出し
  container.ts   XtcConverterContainer + convertInContainer（@cloudflare/containers）
  validate.ts    SSRF 対策の URL 検証（DoH 事前解決含む）
  types.ts       Env 型・ConvertJobParams
converter/
  Dockerfile     マルチステージ（builder で xtctool を venv へ）+ 非 root 実行
  app.py         POST /convert（PDF bytes → XTC bytes）/ GET /healthz
                 graceful shutdown（SIGTERM でドレイン）、同時変換制限付き
  config-x3.toml X3 用変換設定
test/
  validate.test.ts        vitest
  auth.test.ts            vitest（認証 OR ロジック。JWT 検証はモック注入）
  jobs.test.ts            vitest（状態写像・キー導出の単体テスト）
  converter/test_app.py   pytest
```

## 補足

- Container イメージは xtctool を検証済み commit（`d7bff34`、2026-07-17 検証）に固定し、非 root ユーザー（uid 10001）で実行する。
- `converter/config-x3.toml` の `resample_method` は BOX（テキスト向き）。写真主体のページが多い場合は LANCZOS に変更する。
- XTC 出力サイズの目安は約 102KB/ページ（4 階調 xth、無圧縮）。
