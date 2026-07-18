# html2xtc 実装プラン

作成日: 2026-07-17 / 対象: [spec.md](../spec.md)

## ゴール

URL を 1 つ POST すると、Cloudflare 上で「印刷用 CSS 適用 → PDF 生成 → XTC 変換 → R2 保存 → ダウンロード URL 返却」まで自動で行う API を作る。ターゲット端末は Xteink X3（528×792）。

役割分担は spec の結論どおり:

| 処理 | 担当 |
|---|---|
| URL 表示・CSS 適用・PDF 生成 | Worker + Browser Run |
| PDF 画像化・ディザリング・XTC 生成 | Cloudflare Container + xtctool |
| 中間ファイル・成果物 | R2 |
| 長時間ジョブ（Phase 2） | Queues または Workflows |

## 前提条件（着手前に確認）

- Cloudflare アカウントが **Workers Paid プラン**（Containers と Browser Run に必須）
- ローカルに Docker（Container イメージのビルドと `wrangler dev` に必要）
- Node.js + 最新 wrangler

## フェーズ構成

### Phase 0: 技術検証スパイク（コードを書く前に潰すリスク）

1. **xtctool のローカル検証**: spec の Dockerfile をローカルでビルドし、手元の PDF で `xtctool convert -c config-x3.toml` が期待どおり動くか確認。CLI のサブコマンド名・オプション体系が spec の記述と一致するかを実物で確認する。
2. **Browser Run API の実仕様確認**: `env.BROWSER.quickAction("pdf", {...})` という呼び出し形状・binding 設定を Cloudflare 公式 docs（cloudflare スキル / context7 経由）で確認。spec のコードは参考実装であり、実 API と差異がある可能性が最大のリスク。
3. **Worker ↔ Container 間通信の確認**: `@cloudflare/containers` の `Container` クラス継承と `containerFetch` の使い方、Durable Object binding 経由の呼び出しを docs で確認。
4. **日本語フォントの確認**: Browser Run の Chromium に Noto Sans JP 等の日本語フォントが存在するか検証。なければ `addStyleTag` で Google Fonts の `@import` を追加する対策を組み込む。

**完了条件**: ローカル Docker で PDF→XTC 変換が成功し、Browser Run / Containers の API 形状が確定していること。

### Phase 1: PoC — 同期 `POST /convert`

spec の推奨どおり、まず同期処理で end-to-end を通す。

1. プロジェクトスキャフォールド（wrangler + TypeScript、下記ディレクトリ構成）
2. **SSRF 対策 v1** (`src/validate.ts`): http/https 以外拒否、localhost・プライベート IP・メタデータ IP（169.254.169.254）拒否。spec のホワイトリスト方式に加え、IP リテラルのプライベートレンジ判定（10.x、172.16-31.x、192.168.x、fc00::/7 等）を追加する
3. **PDF 生成** (`src/pdf.ts`): X3 印刷用 CSS（spec の `X3_PRINT_CSS` をそのまま採用: 66mm×99mm ページ、nav/footer/広告類の非表示、pre の折返し）+ Browser Run 呼び出し + R2 への `jobs/{jobId}/source.pdf` 保存
4. **Container** (`converter/`): spec の Dockerfile / config-x3.toml / app.py をベースにする。ただし PDF の受け渡しは **Worker から Container へバイト直送**に変更（下記「設計判断」参照）
5. **Worker 本体** (`src/index.ts`): `POST /convert` → 検証 → PDF 生成 → R2 保存 → Container `/convert` 呼び出し → XTC を `jobs/{jobId}/output.xtc` に保存 → `GET /download/{jobId}` の URL を返却
6. `GET /download/{jobId}`: R2 から XTC を `Content-Disposition: attachment` で返す
7. `wrangler dev` でローカル確認 → `wrangler deploy` で本番デプロイ → 実 URL（Wikipedia 記事等）で動作確認

**完了条件**: デプロイ済み環境で URL を POST し、返ってきた XTC が実機（または xtctool の逆変換/ビューア）で読めること。

### Phase 2: 非同期ジョブ化

数十ページのドキュメントで同期処理がタイムアウトする問題への対応。

1. API を spec の非同期形に拡張:
   - `POST /jobs` → 202 + jobId
   - `GET /jobs/{jobId}` → `queued / rendering / converting / completed / failed`
   - `GET /jobs/{jobId}/download` → XTC
2. **ジョブ実行基盤の選定**: spec は Queues（consumer wall time 最大 15 分）を提案。代替として **Workflows**（ステップ単位のリトライ・状態永続化が組み込み）も有力。Phase 2 着手時に docs を確認して決定する。ステップが「PDF 生成 → 変換 → 保存」と直列で、途中失敗時の再開が欲しいため、推奨は Workflows。
3. ジョブ状態ストア: Workflows ならインスタンス status をそのまま利用。Queues 案なら KV or D1 に状態を持つ。
4. R2 ライフサイクルルールで中間 PDF（`jobs/*/source.pdf`）を自動削除。

### Phase 3: 堅牢化・セキュリティ

spec「注意点」節の残項目を消化する。

- **SSRF 強化**: リダイレクト先の再検証（Browser Run 側オプションで制御できるか確認）、最大ページ数・最大処理時間の上限設定
- **アクセス制御**: レート制限で濫用を抑止（認証は設けず一般公開）
- **エラーハンドリング**: Browser Run 失敗（502）、xtctool 失敗（stderr をログへ）、R2 障害の各系統を分離してレスポンスコードを整理
- **observability**: `wrangler.jsonc` で observability 有効化、jobId 単位の構造化ログ
- **テスト**: `@cloudflare/vitest-pool-workers` で validate/ルーティングの単体テスト、Container の app.py は pytest でローカルテスト

### Phase 4（任意）: 簡易フロント UI

URL 入力フォーム + 進捗表示 + ダウンロードリンクの 1 ページを Worker の static assets で配信。API が固まってから着手。

## ディレクトリ構成

```
html2xtc/
├── wrangler.jsonc          # spec の設定をベースに Phase 0 の確認結果で修正
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # ルーティング・エンドポイント
│   ├── pdf.ts              # Browser Run 呼び出し + X3_PRINT_CSS
│   ├── container.ts        # XtcConverterContainer（Container クラス継承）
│   ├── validate.ts         # SSRF 対策の URL 検証
│   └── types.ts            # Env・ジョブ状態の型
├── converter/
│   ├── Dockerfile          # python:3.12-slim + xtctool[performance]
│   ├── app.py              # /convert HTTP サーバ
│   └── config-x3.toml      # X3 用 528×792 設定
├── test/
│   ├── validate.test.ts
│   └── converter/test_app.py
└── claudedocs/
    └── implementation-plan.md
```

## 設計判断（spec からの変更・確定事項）

1. **PDF/XTC の受け渡しはバイト直送**: spec の app.py は `pdfUrl` を Container 側からダウンロードする設計だが、Container から R2 へ直接アクセスするには S3 互換 API のクレデンシャル管理か presigned URL 生成が必要になる。PoC では Worker → Container へ PDF バイトを POST し、XTC バイトをレスポンスで受けて Worker が R2 に保存する方が構成要素が少ない。R2 への読み書きは Worker の binding に一元化する（spec の「R2 経由が安全」の趣旨＝ユーザー入力 URL を Container に踏ませない、も満たせる）。
2. **Container クラス**: 素の Durable Object ではなく `@cloudflare/containers` パッケージの `Container` クラスを継承する（sleep 管理・port 設定が楽）。
3. **同期版でもタイムアウト上限を設定**: Browser Run 30 秒 + xtctool 600 秒は同期 API には長すぎるため、PoC では xtctool 側タイムアウトを 120 秒程度に絞り、超える場合は Phase 2 の非同期へ誘導するエラーを返す。

## リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| Browser Run の API 形状が spec と異なる | Worker コード書き直し | Phase 0 で docs 確認してから実装 |
| xtctool の CLI/設定が spec と異なる・PDF 変換品質が悪い | Container 作り直し | Phase 0 でローカル検証を最初に実施 |
| 日本語フォント欠落で PDF が豆腐になる | 出力が使い物にならない | Phase 0 で検証、Web フォント読込で代替 |
| Container のコールドスタートが遅い | 同期 API の体感が悪い | `max_instances: 2` + sleep 猶予設定、Phase 2 で非同期化 |
| 同期処理が長文書でタイムアウト | 一部 URL で失敗 | Phase 1 はページ数の少ない記事に限定し、Phase 2 で解消 |

## コスト目安

Workers Paid（$5/月）が下限。加えて Container の実行時間課金、Browser Run の課金、R2 ストレージ（微小）。個人利用の変換頻度なら Paid プラン基本料 + 数ドル以内に収まる見込み（未検証）。

## 次のアクション

1. Phase 0-1: xtctool の Docker ローカル検証（このマシンで即実行可能）
2. Phase 0-2: Browser Run / Containers の docs 確認
3. 確認結果を反映してスキャフォールド作成 → Phase 1 実装
