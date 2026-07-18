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

### 3. デプロイ

```bash
npx wrangler deploy
```

このとき自動で行われること:
- converter/Dockerfile を linux/amd64 でビルドし、Cloudflare Registry へ push（初回は数分かかる）
- Durable Object マイグレーション（XtcConverterContainer）の適用
- Worker 本体のアップロード

完了すると `https://url-to-xtc.<your-subdomain>.workers.dev` が表示される。

### 4. 動作確認

```bash
# 変換
curl -X POST https://url-to-xtc.<your-subdomain>.workers.dev/convert \
  -H "Content-Type: application/json" \
  -d '{"url": "https://ja.wikipedia.org/wiki/%E9%9B%BB%E5%AD%90%E3%83%9A%E3%83%BC%E3%83%91%E3%83%BC"}'
# → {"jobId":"...","downloadUrl":"/download/..."} が返る

# ダウンロード
curl -L -o test.xtc \
  https://url-to-xtc.<your-subdomain>.workers.dev/download/<jobId>
```

初回リクエストはコンテナのコールドスタート（1〜3 秒）+ deploy 直後はイメージの pre-fetch が完了していない場合があり、遅い・失敗することがある。失敗したら 1〜2 分待って再試行する。

生成された test.xtc は Xteink X3 に転送して表示確認する。

ログの確認:

```bash
npx wrangler tail
```

### 5. R2 ライフサイクルルール

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
npx wrangler r2 bucket lifecycle add xteink-conversions expire-job-outputs jobs/ --expire-days 1
npx wrangler r2 bucket lifecycle list xteink-conversions   # 確認
```

- 中間 PDF（`intermediate/{jobId}/source.pdf`）・成果物 XTC（`jobs/{jobId}/output.xtc`）とも 1 日（24 時間）で自動削除される（削除は expiration から最大 ~24h 遅延）。一般公開ハードニングで `jobs/` を 30 日 → 24 時間に短縮した。既存バケットに旧 30 日ルールが残っている場合は `lifecycle remove` で削除してから上記を再適用すること。
- 旧配置の `jobs/*/source.pdf` は `jobs/` の 1 日ルールでいずれ消えるため移行処理は不要。

### 動作確認

```bash
BASE=https://url-to-xtc.<your-subdomain>.workers.dev

# 1. ジョブ投入（202 が返る）
curl -X POST "$BASE/jobs" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://ja.wikipedia.org/wiki/%E9%9B%BB%E5%AD%90%E3%83%9A%E3%83%BC%E3%83%91%E3%83%BC"}'
# → {"jobId":"<uuid>","statusUrl":"/jobs/<uuid>"}

# 2. ポーリング（queued → rendering → converting → completed）
curl "$BASE/jobs/<jobId>"
# → {"jobId":"...","status":"completed","downloadUrl":"/jobs/<jobId>/download"}
# 失敗時は {"jobId":"...","status":"failed","error":"..."}

# 3. ダウンロード（未完了なら 409 + {status}、不明 jobId なら 404）
curl -L -o test.xtc "$BASE/jobs/<jobId>/download"
```

本番 E2E 実測済み（2026-07-17）: 短ページ 62 秒 / 長ページ（Phase 1 で 128 秒タイムアウトしていた記事）153 秒で completed、converting フェーズ約 140 秒 > 旧 120 秒制限を Workflow ステップ内 Container fetch で問題なく通過。404・409・SSRF 拒否・同期 /convert 後方互換も全項目 PASS。

## Phase 4: WebUI

Phase 4 で `public/index.html`（スマホ向け 1 ページ UI）が追加された。`wrangler deploy` だけで静的アセットも一緒に配信される（追加コマンド不要）。アセット配信は Worker を通らず、エッジから直接配信される。認証は設けておらず、UI・API とも一般公開（悪用対策はレート制限と SSRF 対策。README 参照）。

### 動作確認

- ブラウザ（スマホ）で `https://url-to-xtc.<your-subdomain>.workers.dev/` を開く → UI が表示される → URL を入れて変換 → 進捗表示 → ダウンロード。
- 履歴はブラウザの localStorage に保存される（最大 50 件、サーバー上のファイルは約 24 時間で自動削除）。

## 運用メモ

- **課金要素**: Workers Paid $5/月 + Browser Run（10 browser-hours/月込み、超過 $0.09/h）+ Containers（メモリ 25 GiB-h/月・CPU 375 vCPU-min/月込み、basic インスタンスは sleepAfter 2 分で自動停止）+ R2（微小）。個人利用なら込み分でほぼ収まる見込み。
- **サイズ上限**: PDF 20MiB（Worker 側 `MAX_PDF_BYTES` env var で変更可）、コンテナ側 50MB。
- **既知の制限**（README にも記載）: リダイレクト先の SSRF 再検証は未対応（DoH による事前解決チェックまで実施）。同期 `/convert` は長大なページでタイムアウトしうるため短ページ専用（長いページは `/jobs` を使う）。
- **xtctool のバージョン**: commit d7bff34 に固定済み（2026-07-17 検証）。更新する場合は Dockerfile の SHA を変えて再検証すること。
- **X3 実機の「メモリエラー」**（2026-07-17 実機確定）: crosspoint-jp v0.1.7 はヒープ断片化で 52KB のページバッファ確保に失敗することがある（ページ数上限ではなく端末状態依存。121 ページ 6.3MB も再起動直後なら表示可）。回避は「大きいファイルは再起動直後に開く」。恒久対策は crosspoint-jp v0.3.0 以降（upstream 1.3.0/1.4.0 のメモリ管理修正取り込み）へのファーム更新。

## 次フェーズ（任意）

implementation-plan.md 参照: Phase 2（非同期ジョブ化）と Phase 4（WebUI）は実装済み（本書の各節参照）。残りは Phase 3（リダイレクト対策強化・レート制限）のみ。
