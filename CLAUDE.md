# html2xtc

## サブエージェント（`.claude/agents/`）

作業は役割ごとのサブエージェントに委譲し、本体は指示・統合・最終確認に徹する。全エージェントは定義の `model: sonnet` で Sonnet 5 に固定済みなので、呼び出し時のモデル指定は不要。

| エージェント | 担当 | 編集 |
|---|---|---|
| `codebase-researcher` | 着手前の調査（対象箇所・依存・既存規約の洗い出し） | 不可 |
| `frontend-impl` | `frontend/` — Svelte 5 SPA、i18n | 可 |
| `worker-impl` | `src/` + `migrations/` — Cloudflare Worker、API、D1/R2 | 可 |
| `converter-impl` | `converter/` — Python + Docker | 可 |
| `change-reviewer` | 差分レビュー（指摘のみ。自分では直さない） | 不可 |
| `deploy-operator` | main へのマージ → 本番デプロイ → worktree 削除 | 不可 |

基本の流れは **調査 → 実装 → レビュー（実装した本人以外）→ 修正 → deploy-operator**。

調査・実装のエージェントは、メイン作業ディレクトリにいる場合は worktree を作ってそこで作業する。ベースは ref 名ではなく SHA を固定する（並行セッションが `origin/main` を動かすため）。詳細は各定義を参照。

## スキル（`.claude/skills/`）

- `deploy` — デプロイ手順の**正**。`npm run deploy` のみで、`wrangler deploy` の直叩きは `.claude/hooks/deploy-guard.sh` が拒否する。

スキルは「どうやるか」、エージェントは「いつ・何を・どの順で」を持つ。**エージェント定義に手順を写さない**（二重管理は片方が腐る）。

## 設定値の扱い

環境変数・モード値（`REGISTRATION_MODE` 等）の正は `wrangler.jsonc`。仕様書や既存コメントを根拠にしない。コードとコメントに具体的なモード値を前提として書かない（実態とずれて腐る）。フロントエンドはサーバー由来の設定を `/api/public/config` から取得する。
