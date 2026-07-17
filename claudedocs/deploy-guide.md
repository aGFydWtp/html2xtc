# デプロイ手順書（wrangler deploy 以降）

作成日: 2026-07-17。コードは実装・レビュー・ローカル検証済み（tsc / vitest 31 件 / pytest 20 件 / docker build すべて成功）。この手順書は `wrangler deploy` 以降にユーザーが行う作業をまとめたもの。

## 前提条件

- Cloudflare アカウントが **Workers Paid プラン**（$5/月。Containers と Browser Run の quickAction に必須）
- **Docker Desktop が起動していること**（deploy 時に converter イメージをローカルビルドし Cloudflare Registry へ自動 push するため）
- このリポジトリで `npm install` 済み（済んでいなければ実行）

## 手順

### 1. Cloudflare にログイン

```bash
npx wrangler login
```

ブラウザが開くので認可する。`npx wrangler whoami` でアカウントを確認できる。

### 2. R2 バケットを作成

```bash
npx wrangler r2 bucket create xteink-conversions
```

wrangler.jsonc の `bucket_name` と一致させてある。既に存在する場合はこのステップは不要。

### 3. API 認証トークンを設定（推奨）

```bash
npx wrangler secret put AUTH_TOKEN
# プロンプトに任意の長いランダム文字列を入力（例: openssl rand -hex 32 で生成）
```

**未設定の場合、API は誰でも叩ける状態でデプロイされる**（Browser Run / Container は従量課金のため、URL を知られると課金濫用のリスクがある）。AUTH_TOKEN を設定するか、手順 6 の Cloudflare Access で保護すること。

注意: `wrangler secret put` は Worker が一度デプロイされていないと失敗することがある。その場合は先に手順 4 を実行してから設定し、再デプロイは不要（secret は即時反映）。

### 4. デプロイ

```bash
npx wrangler deploy
```

このとき自動で行われること:
- converter/Dockerfile を linux/amd64 でビルドし、Cloudflare Registry へ push（初回は数分かかる）
- Durable Object マイグレーション（XtcConverterContainer）の適用
- Worker 本体のアップロード

完了すると `https://url-to-xtc.<your-subdomain>.workers.dev` が表示される。

### 5. 動作確認

```bash
# 変換（AUTH_TOKEN を設定した場合は -H "Authorization: Bearer <token>" を付与）
curl -X POST https://url-to-xtc.<your-subdomain>.workers.dev/convert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"url": "https://ja.wikipedia.org/wiki/%E9%9B%BB%E5%AD%90%E3%83%9A%E3%83%BC%E3%83%91%E3%83%BC"}'
# → {"jobId":"...","downloadUrl":"/download/..."} が返る

# ダウンロード
curl -L -o test.xtc \
  -H "Authorization: Bearer <token>" \
  https://url-to-xtc.<your-subdomain>.workers.dev/download/<jobId>
```

初回リクエストはコンテナのコールドスタート（1〜3 秒）+ deploy 直後はイメージの pre-fetch が完了していない場合があり、遅い・失敗することがある。失敗したら 1〜2 分待って再試行する。

生成された test.xtc は Xteink X3 に転送して表示確認する。

ログの確認:

```bash
npx wrangler tail
```

### 6. Cloudflare Access で保護（AUTH_TOKEN の代替または併用）

ブラウザから使いたい場合は Access の方が便利。

1. Cloudflare ダッシュボード → Zero Trust → Access → Applications → Add an application → Self-hosted
2. ドメインに `url-to-xtc.<your-subdomain>.workers.dev` を指定
3. ポリシーで自分のメールアドレスを Allow に設定

### 7. R2 ライフサイクルルール

Phase 2 で CLI による正式なルールを定めた。下記「Phase 2 デプロイ手順」の lifecycle コマンド 2 行を一度だけ実行すること（ダッシュボードからの手動設定は不要になった）。

## Phase 2 デプロイ手順（非同期ジョブ化）

Phase 2（Workflows による `/jobs` API）のデプロイは通常どおり:

```bash
npx wrangler deploy
```

Workflows（`xtc-convert` / `ConvertWorkflow`）は wrangler.jsonc の `workflows` 設定から自動でプロビジョンされる。追加のリソース作成コマンドは不要。

### R2 ライフサイクルルール（一度だけ実行）

lifecycle は wrangler.jsonc では設定できないため、デプロイとは別に一度だけ適用する:

```bash
npx wrangler r2 bucket lifecycle add xteink-conversions expire-intermediate-pdf intermediate/ --expire-days 1
npx wrangler r2 bucket lifecycle add xteink-conversions expire-job-outputs jobs/ --expire-days 30
npx wrangler r2 bucket lifecycle list xteink-conversions   # 確認
```

- 中間 PDF（`intermediate/{jobId}/source.pdf`）は 1 日、成果物 XTC（`jobs/{jobId}/output.xtc`）は 30 日で自動削除される（削除は expiration から最大 ~24h 遅延）。
- 旧配置の `jobs/*/source.pdf` は `jobs/` の 30 日ルールでいずれ消えるため移行処理は不要。

### 動作確認

```bash
BASE=https://url-to-xtc.<your-subdomain>.workers.dev
# 以下の Authorization ヘッダは AUTH_TOKEN 設定時のみ必要

# 1. ジョブ投入（202 が返る）
curl -X POST "$BASE/jobs" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"url": "https://ja.wikipedia.org/wiki/%E9%9B%BB%E5%AD%90%E3%83%9A%E3%83%BC%E3%83%91%E3%83%BC"}'
# → {"jobId":"<uuid>","statusUrl":"/jobs/<uuid>"}

# 2. ポーリング（queued → rendering → converting → completed）
curl -H "Authorization: Bearer <token>" "$BASE/jobs/<jobId>"
# → {"jobId":"...","status":"completed","downloadUrl":"/jobs/<jobId>/download"}
# 失敗時は {"jobId":"...","status":"failed","error":"..."}

# 3. ダウンロード（未完了なら 409 + {status}、不明 jobId なら 404）
curl -L -o test.xtc -H "Authorization: Bearer <token>" "$BASE/jobs/<jobId>/download"
```

本番 E2E 実測済み（2026-07-17）: 短ページ 62 秒 / 長ページ（Phase 1 で 128 秒タイムアウトしていた記事）153 秒で completed、converting フェーズ約 140 秒 > 旧 120 秒制限を Workflow ステップ内 Container fetch で問題なく通過。認証 401・404・409・SSRF 拒否・同期 /convert 後方互換も全項目 PASS。

## Phase 4: WebUI と Cloudflare Access

Phase 4 で `public/index.html`（スマホ向け 1 ページ UI）が追加された。`wrangler deploy` だけで静的アセットも一緒に配信される（追加コマンド不要）。**アセット配信は Worker を通らないため、UI の保護はエッジ側の Cloudflare Access が前提**。API 側は「Access JWT または Bearer AUTH_TOKEN」の OR で検証する。

以下はすべてユーザーの手動作業（コード変更不要）。出典・詳細は scratchpad/research-ui.md。

> **警告（フェイルオープン）**: `AUTH_TOKEN`・`ACCESS_TEAM_DOMAIN`・`ACCESS_POLICY_AUD` がすべて未設定だと Worker は**無認証で公開**される（ローカル開発向けの仕様）。デプロイ前チェックリスト: (a) エッジの Access 有効化（4-2）または (b) `AUTH_TOKEN` secret 設定 の少なくとも一方が済んでいること。

### 4-1. Zero Trust チームの作成（未作成の場合のみ）

Cloudflare ダッシュボード → Zero Trust を開き、チーム名（team domain `<team>.cloudflareaccess.com`）を決めて作成する。Free プランで可（1 人運用なら無料枠内）。

### 4-2. workers.dev に Access を有効化（ワンクリック）

1. ダッシュボード → **Workers & Pages** → `url-to-xtc` → **Settings → Domains & Routes**
2. `workers.dev` の行で **Enable Cloudflare Access** をクリック
3. **Manage Cloudflare Access** で作成された Access アプリを開く

これでホスト全体（UI・API とも）がエッジで保護される。

### 4-3. Allow ポリシー（ブラウザ用）

Access アプリのポリシーを編集し、Action=**Allow**、Include: **Emails = 自分のメールアドレス** を設定する。ログイン方法は One-time PIN（デフォルトで利用可。メールに届く PIN を入力）。

### 4-4. AUD タグを取得し Worker に設定

1. Zero Trust → **Access controls → Applications** → 対象アプリの **Configure** → **Additional settings** → **Application Audience (AUD) Tag** をコピー（アプリを削除・再作成しない限り不変）
2. Worker に vars を設定する（機密情報ではないので plain vars で可）。wrangler.jsonc に追記して deploy するか、ダッシュボードの Variables から設定:

```jsonc
// wrangler.jsonc に追記する場合
"vars": {
  "ACCESS_TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
  "ACCESS_POLICY_AUD": "<AUD タグ>"
}
```

両方を設定したときのみ Worker 内の Access JWT 検証（`Cf-Access-Jwt-Assertion` を jose で検証）が有効になる。未設定なら従来どおり Bearer AUTH_TOKEN のみ（ローカル開発は両方未設定で無認証）。

### 4-5. Service Token の作成（curl / 自動化用）

Access 有効化後は、素の `Authorization: Bearer` だけの curl は**エッジで遮断され Worker に届かない**。CLI からは Access service token を使う:

1. Zero Trust → **Access controls → Service credentials → Service Tokens** → **Create Service Token**（期間を選択。**Client Secret は生成時にしか表示されない**ので保管する）
2. Access アプリに Action=**Service Auth**、Include: **Service Token = 作成したトークン** のポリシーを追加

### 4-6. curl 例のヘッダ変更

既存の curl / スクリプトに service token のヘッダ 2 つを追加する（Bearer は不要になるが、付けたままでも害はない）:

```bash
curl -X POST "$BASE/jobs" \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: <Client ID>" \
  -H "CF-Access-Client-Secret: <Client Secret>" \
  -d '{"url": "https://example.com/article"}'
```

service token で認証されたリクエストにも Access は同じ AUD の JWT を発行するため、Worker 内の検証 1 本で人間（ブラウザ）・マシン（curl）の両方をカバーできる。

### 4-7. 動作確認

- ブラウザ（スマホ）で `https://url-to-xtc.<your-subdomain>.workers.dev/` を開く → Access のログイン（One-time PIN）→ UI が表示される → URL を入れて変換 → 進捗表示 → ダウンロード。
- 履歴はブラウザの localStorage に保存される（最大 50 件、サーバー上のファイルは約 30 日で自動削除）。
- 手順 6 の旧 Access 手動設定は本節（ワンクリック有効化）で置き換えられた。

## 運用メモ

- **課金要素**: Workers Paid $5/月 + Browser Run（10 browser-hours/月込み、超過 $0.09/h）+ Containers（メモリ 25 GiB-h/月・CPU 375 vCPU-min/月込み、basic インスタンスは sleepAfter 2 分で自動停止）+ R2（微小）。個人利用なら込み分でほぼ収まる見込み。
- **サイズ上限**: PDF 20MiB（Worker 側 `MAX_PDF_BYTES` env var で変更可）、コンテナ側 50MB。
- **既知の制限**（README にも記載）: リダイレクト先の SSRF 再検証は未対応（DoH による事前解決チェックまで実施）。同期 `/convert` は長大なページでタイムアウトしうるため短ページ専用（長いページは `/jobs` を使う）。
- **xtctool のバージョン**: commit d7bff34 に固定済み（2026-07-17 検証）。更新する場合は Dockerfile の SHA を変えて再検証すること。
- **X3 実機の「メモリエラー」**（2026-07-17 実機確定）: crosspoint-jp v0.1.7 はヒープ断片化で 52KB のページバッファ確保に失敗することがある（ページ数上限ではなく端末状態依存。121 ページ 6.3MB も再起動直後なら表示可）。回避は「大きいファイルは再起動直後に開く」。恒久対策は crosspoint-jp v0.3.0 以降（upstream 1.3.0/1.4.0 のメモリ管理修正取り込み）へのファーム更新。

## 次フェーズ（任意）

implementation-plan.md 参照: Phase 2（非同期ジョブ化）と Phase 4（WebUI・Cloudflare Access）は実装済み（本書の各節参照）。残りは Phase 3（リダイレクト対策強化・レート制限）のみ。
