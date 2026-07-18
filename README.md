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

- PDF/XTC のバイト列は Worker ↔ Container 間で直接送受信する。R2 への読み書きは Worker の binding に一元化し、Container には R2 クレデンシャルもユーザー入力 URL も渡さない。
- Container は固定プール名（`converter-0` / `converter-1`、`max_instances: 2` に対応）に jobId のハッシュで振り分け、ウォームインスタンスを再利用する。
- 変換設定は `converter/config-x3.toml`（528×792、4 階調 xth、日本語メタデータ）。

## WebUI

`public/index.html`（依存なしの 1 ページ、スマホファースト）を Workers static assets として `/` で配信する。URL を入力すると `POST /jobs` → 数秒間隔のポーリングで進捗（待機中 → PDF 生成中 → XTC 変換中）を表示し、完了するとダウンロードリンクが出る。履歴はブラウザの localStorage に保存（最大 50 件。サーバー上のファイルは約 24 時間で自動削除される旨を表示）。サービス概要・利用規約・クローラー情報・連絡先は `/about`（`public/about.html`、静的配信）に掲示し、フッターからリンクする。

静的アセットの配信は Worker を通らないため、UI の保護はエッジ側の **Cloudflare Access**（workers.dev のワンクリック有効化）が前提。設定手順は claudedocs/deploy-guide.md を参照。

## 認証

API（`/convert` `/jobs` `/download`）は次の **OR** で通す（`src/auth.ts`）:

- **Cloudflare Access JWT**: vars `ACCESS_TEAM_DOMAIN` と `ACCESS_POLICY_AUD` を両方設定したときのみ有効。`Cf-Access-Jwt-Assertion` ヘッダ（フォールバックで `CF_Authorization` クッキー）の JWT を jose で検証する。ブラウザは Access ログイン、CLI は Access service token（`CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダ）で通る。
- **Bearer トークン**: `AUTH_TOKEN` secret（`wrangler secret put AUTH_TOKEN`）を設定すると `Authorization: Bearer <token>` を検証（不一致は 401）。ローカル開発・Access を使わない構成向け。

認証なしで通すのは `ACCESS_TEAM_DOMAIN`・`ACCESS_POLICY_AUD`・`AUTH_TOKEN` の**3 つすべてが未設定**の場合のみ（ローカル開発用）。Access の 2 変数のうち片方だけ設定されている状態は誤設定（typo・設定漏れ）として扱い、素通しにはならない: Access JWT は受け付けず、`AUTH_TOKEN` が設定されていれば Bearer 認証のみ有効、なければ 401 を返す（フェイルクローズ）。**本番デプロイでは Cloudflare Access で保護するか、AUTH_TOKEN の設定が必須。** なお Access をエッジで有効化すると、素の Bearer だけのリクエストはエッジで遮断されるため CLI は service token が必要（deploy-guide 参照）。

## レート制限

変換を起動するエンドポイント（`POST /convert`・`POST /jobs`）は IP ごとに **1 時間あたり 50 件**（固定窓、Worker の var `RATE_LIMIT_PER_HOUR` で変更可）に制限する（`src/ratelimit.ts` / `src/ratelimiter.ts`）。IP は Cloudflare エッジが設定する `CF-Connecting-IP` から取り、IPv6 は /64 プレフィックス単位で数える（プレフィックス内でアドレスを回すすり抜け対策）。超過時は 429 + `Retry-After`（窓リセットまでの秒数）を返す。カウントは IP キーごとの Durable Object が保持し、DO 呼び出しが失敗した場合はブロックせず通す（validate.ts の DoH 障害時と同じ可用性優先）。GET 系（状態確認・ダウンロード）は対象外。

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
| 429 | IP ごとのレート制限超過（`Retry-After` ヘッダ付き） |
| 500 | Workflow インスタンス作成失敗 |

裏側は Cloudflare Workflows（render-pdf → convert-xtc → delete-intermediate-pdf）。render / convert は失敗時にそのステップだけ再試行される（render: 2 回 / convert: 2 回。PDF サイズ超過などの恒久エラーは再試行なしで failed）。最後のステップは変換の成否にかかわらず中間 PDF を即削除する（best-effort）。

### GET /jobs/{jobId}

ジョブ状態を返す。ポーリングして `completed` を待つ。

```json
{ "jobId": "<uuid>", "status": "converting" }
```

- `status`: `queued` → `rendering` → `converting` → `completed` | `failed`
- `completed` 時は `downloadUrl`（`/jobs/{jobId}/download`）付き、`failed` 時は `error`（メッセージ）付き。
- `rendering`/`converting` の区別は R2 上の中間 PDF（`intermediate/{jobId}/source.pdf`）の有無から導出する（Workflows の status() は実行中ステップ名を返さないため）。
- jobId が UUID 形式でなければ 400、不明・Workflows インスタンスの保持期限切れ（プラットフォーム固定 30 日）なら 404。なお成果物 XTC 自体は R2 lifecycle により約 24 時間で削除される（ダウンロード側で 404）。

### GET /jobs/{jobId}/download

R2 上の XTC（`jobs/{jobId}/output.xtc`）を attachment で返す。未完了なら 409 + `{status}`、不明 jobId・成果物期限切れ（約 24 時間）・失敗ジョブなら 404。

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
| 400 | body が JSON でない / `url` 欠落 / URL 検証エラー（スキーム・禁止 IP・DoH 解決結果が禁止レンジまたは解決 IP 0 件） |
| 401 | AUTH_TOKEN 設定時、Bearer トークン欠落・不一致 |
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
| 生成 PDF の上限（Worker） | 20 MiB | Worker の var `MAX_PDF_BYTES`（バイト数） |
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
npx wrangler secret put AUTH_TOKEN   # 本番は必須（または Cloudflare Access）
npx wrangler deploy
```

## 構成ファイル

```
public/
  index.html     スマホ向け WebUI（vanilla 1 ページ、Workers static assets で配信）
  about.html     サービス概要・利用規約・クローラー情報・連絡先（/about、静的配信）
src/
  index.ts       ルーティング・エラーハンドリング
  auth.ts        認証（Access JWT または Bearer AUTH_TOKEN の OR）
  workflow.ts    ConvertWorkflow（render-pdf → convert-xtc の 2 ステップ）
  jobs.ts        ジョブ状態写像・R2 キー導出（純関数、vitest 対象）
  pdf.ts         X3_PRINT_CSS + Browser Run quickAction("pdf") 呼び出し
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
  auth.test.ts            vitest（認証 OR ロジック。JWT 検証はモック注入）
  jobs.test.ts            vitest（状態写像・キー導出の単体テスト）
  ratelimit.test.ts       vitest（IP キー正規化・固定窓判定・上限パース）
  converter/test_app.py   pytest
```

## ライセンス

本リポジトリのコードは [MIT License](LICENSE)。本プロジェクトは **Xteink 社とは無関係な非公式ツール**であり、権利者の承認・提携・保証を受けていない。

変換に使う [xtctool](https://github.com/chazeon/xtctool)（GPL-3.0 として扱う）と PyMuPDF（AGPL-3.0 / 商用デュアル）はリポジトリに含まれず、Docker ビルド時に取得する。使用コミット・ビルド時に加えている変更・配布時の義務は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。**Docker イメージを第三者へ配布する場合は同ファイル記載の GPL/AGPL 対応が必要。**

## 補足

- Container イメージは xtctool を検証済み commit（`d7bff34`、2026-07-17 検証）に固定し、非 root ユーザー（uid 10001）で実行する。
- `converter/config-x3.toml` の `resample_method` は BOX（テキスト向き）。写真主体のページが多い場合は LANCZOS に変更する。
- XTC 出力サイズの目安は約 102KB/ページ（4 階調 xth、無圧縮）。
