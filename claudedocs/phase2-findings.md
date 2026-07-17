# Phase 2 調査結果と設計確定（非同期ジョブ化）

作成日: 2026-07-17。2 つの調査エージェントが公式 docs（developers.cloudflare.com、当日取得）と node_modules 実物（wrangler@4.112.0 / @cloudflare/containers@0.3.7）で裏取りした事実に基づく。実装はこのファイルを正とする。

## 選定結論: Cloudflare Workflows を採用（Queues 不採用）

| 観点 | Workflows | Queues |
|---|---|---|
| 実行時間 | ステップ wall-clock **無制限**（CPU 30s/step デフォルト、fetch 待ちは I/O なので消費しない） | consumer wall time 15 分固定 |
| 再試行の粒度 | ステップ単位（変換のみ再試行可） | メッセージ単位（PDF 再生成からやり直し） |
| 状態照会 | `get(id).status()` 組み込み（error 詳細・output 付き） | KV/D1 に全状態を自前実装 |
| jobId | `create({ id })` で任意 UUID 指定可 → `GET /jobs/{id}` に直結 | 状態キーを自前管理 |
| 料金 | Workers Paid 込み。本件規模（2 ステップ/ジョブ）は無料枠内 | 同等だが queue×2 + 状態ストアが追加 |

「PDF 生成 → XTC 変換」という直列 2 ステップ・変換だけ長時間・途中失敗時はそのステップだけ再試行したい、という要件に Workflows が正確に一致する。

### Workflows の確定制約値（Workers Paid）

- `create({ id, params })`: ID は最大 100 文字 `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`（UUID 適合）。**同一 ID は保持期間（30 日）内で再利用不可 → create は throw**（UUID 衝突は実質ないが try/catch する）。params 上限 1MiB。
- `get(id)`: 不在・保持期限切れは **throw** → API では 404 に写像。
- `instance.status()`: `queued / running / paused / errored / terminated / complete / waiting / ...` + `error {name,message}` + `output`（run の戻り値）。**実行中ステップ名は取得不可**。
- `step.do` デフォルトは `{ retries: { limit: 5, delay: 10s, backoff: "exponential" }, timeout: "10 minutes" }`。**timeout は試行ごと** → 最大 10 分の変換には不足しうるので変換ステップは `timeout: "12 minutes"` を明示。
- ステップ戻り値（非 stream）は **1MiB 上限** → PDF/XTC のバイナリは R2 経由でキー文字列のみ受け渡す（既存設計と一致）。
- `NonRetryableError`（`cloudflare:workflows`）で恒久エラー（サイズ超過等）はリトライさせない。
- import は `cloudflare:workers`（`WorkflowEntrypoint` 等）。wrangler.jsonc はトップレベル `workflows: [{ name, binding, class_name }]`。Workflow クラスに migrations は不要。

## ジョブ状態の設計: インスタンス status + R2 導出（KV 不採用）

権威ある状態は `instance.status()`。`running` 中の細分フェーズ（rendering / converting）はステップ名を status() から取れないため補助情報が必要になるが、**専用ストア（KV）は追加せず、R2 上の中間 PDF の存在で導出する**:

| instance.status() | 補助判定 | API status |
|---|---|---|
| `queued` | — | `queued` |
| `running` / `waiting` / `paused` 等 | `intermediate/{jobId}/source.pdf` が**無い** | `rendering` |
| `running` / `waiting` / `paused` 等 | 同キーが**有る** | `converting` |
| `complete` | — | `completed`（+ downloadUrl） |
| `errored` / `terminated` | `status().error.message` | `failed`（+ error） |
| get(id) が throw | R2 に output.xtc があればダウンロード可 | 404（download は R2 存在で判定） |

KV 不採用の理由: 調査では「KV をフェーズ表示専用に併用」案が示されたが、(a) フェーズは「中間 PDF が書かれたか」から強整合で導出できる、(b) 新規 KV namespace の作成・id 記入・TTL 管理が丸ごと不要になる、(c) KV は結果整合でむしろ表示が数十秒遅れる。render ステップ再試行中に一瞬 `converting` と誤表示しうるが表示専用のため許容（YAGNI）。ジョブ一覧などクエリ要件が出たら D1/KV を再検討する。

## R2 キー配置とライフサイクル

R2 lifecycle rule の条件は **prefix のみ**（suffix/ワイルドカード不可）。`jobs/{jobId}/` 直下に source.pdf と output.xtc が同居する現行配置では中間 PDF だけを削除できないため、**中間物を `intermediate/` prefix に分離**する:

| 用途 | キー | 保持 |
|---|---|---|
| 中間 PDF | `intermediate/{jobId}/source.pdf`（旧: `jobs/{jobId}/source.pdf`） | 1 日で自動削除 |
| 成果物 XTC | `jobs/{jobId}/output.xtc`（変更なし） | 30 日で自動削除 |

- lifecycle は **wrangler.jsonc では設定不可**（config-schema 実物確認）。デプロイとは別に一度だけ適用する:
  ```sh
  npx wrangler r2 bucket lifecycle add xteink-conversions expire-intermediate-pdf intermediate/ --expire-days 1
  npx wrangler r2 bucket lifecycle add xteink-conversions expire-job-outputs jobs/ --expire-days 30
  npx wrangler r2 bucket lifecycle list xteink-conversions
  ```
- 削除は expiration から最大 ~24h 遅延（実保持は最大 2 日弱/31 日弱になり得る）。
- 既存の `jobs/*/source.pdf` は `jobs/` 30 日ルールでいずれ消えるため移行処理は不要。

## タイムアウト構成（非同期化後）

| 層 | 現行 | Phase 2 | 変更箇所 |
|---|---|---|---|
| xtctool subprocess | 120 秒（env 既定） | **600 秒** | `src/container.ts` に `envVars = { XTC_TIMEOUT_SECONDS: "600" }`（app.py の環境変数名は `XTC_TIMEOUT_SECONDS`。Dockerfile 変更不要） |
| Worker→Container fetch（Workflow 経由） | 150 秒 | **630 秒**（600+30 マージン） | convertInContainer にタイムアウト引数を追加 |
| Worker→Container fetch（同期 /convert） | 150 秒 | **150 秒のまま**（短ページ用途） | — |
| Workflow 変換ステップ timeout | — | **12 分/試行**（明示必須） | `src/workflow.ts` |
| Browser Run goto / pdf | 30s / 30s | **60s / 300s**（goto 上限 60 秒・pdf 上限 5 分は docs 確認済み） | `src/pdf.ts` |

- Worker→DO(Container) の fetch は呼び出し元接続中 wall time 無制限（docs 確認済み）。Workflow ステップの wall-clock も無制限のため 10 分待ちは成立する（実測は未検証）。
- コンテナ側ドレイン待ちは `CONVERT_TIMEOUT_SECONDS + 10` で自動追従（610 秒）。`sleepAfter: "2m"` は変更不要（処理中は生存）。

## instance_type: basic 継続

- basic = 1/4 vCPU・1GiB・4GB。standard-1（1/2 vCPU・4GiB）は速度ほぼ半減見込み【未実測】だが、CPU 課金は実使用ベースで同額、メモリはプロビジョン課金でアイドル（sleepAfter 2 分間）の無料枠消費が 4 倍になる。
- 非同期化後はユーザーがポーリング待ちのため速度半減の価値が低い。600 秒タイムアウトなら basic で ~500 ページ級まで線形仮定で耐える【推測】。
- 600 秒超過や OOM が観測されたら `instance_type` 1 行変更 + 再デプロイで standard-1 へ（可逆）。

## API 仕様（Phase 2）

- `POST /jobs` `{url}` → URL 検証（validatePublicUrl）→ `create({ id: randomUUID, params: { url } })` → **202** `{ jobId, statusUrl }`
- `GET /jobs/{jobId}` → 上表の写像で `{ jobId, status, downloadUrl?, error? }`
- `GET /jobs/{jobId}/download` → R2 の `jobs/{jobId}/output.xtc` が存在すれば attachment 返却。無ければ instance 状態から 409（未完了）/ 404（不明）を返す
- 既存 `POST /convert` / `GET /download/{jobId}` は**短ページ用に存続**（挙動不変・非推奨を README/deploy-guide に明記）。長時間化対応は /jobs 側のみ。

## 未確認事項（実装・検証時に潰す）

1. `wrangler types` が `WorkflowEntrypoint` / binding の `Workflow` 型を生成するか（実装時に確認。`@cloudflare/workers-types` に `Workflow` 型あり）。
2. Workflow ステップ内からの 10 分 Container fetch の実測（本番デプロイ後の E2E で検証）。
3. `wrangler dev` での Workflows + Containers + `browser.remote: true` 併用挙動。
4. `@cloudflare/vitest-pool-workers` での Workflow クラスのテスト可否（不可ならルーティング/写像ロジックをモックで単体テスト）。

## 調査元レポート

- scratchpad/research-infra.md（Workflows vs Queues、制限値、コード骨子）
- scratchpad/research-ops.md（R2 lifecycle、Container envVars、instance_type、Browser Run timeouts）
