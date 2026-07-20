---
name: deploy
description: html2xtc を Cloudflare にデプロイする。デプロイ・deploy・wrangler deploy を頼まれたら必ずこのスキルに従う。
---

# html2xtc のデプロイ手順

## 手順

デプロイは必ず以下のコマンドで行う。

```bash
npm run deploy
```

`wrangler deploy`（`npx wrangler deploy` / `wrangler versions upload` / `wrangler versions deploy` を含む）の直叩きは**禁止**。プロジェクト hook（`.claude/hooks/deploy-guard.sh`）でもブロックされる。

## 事前条件

- 作業ツリーがクリーン（未コミットの変更がない）
- HEAD が origin/main に push 済み

`scripts/deploy.sh` がこの 2 点を検証し、満たさない場合はデプロイせずエラー終了する。

## デプロイ時の動作

1. 上記 2 つの事前条件を検証（満たさなければデプロイせずエラー終了）
2. フロントエンド（Vite + Svelte 5）を `npm ci --prefix frontend && npm run build --prefix frontend` でビルド
3. 稼働コミットを WebUI フッターに表示するための `frontend/dist/version.json`（`{"commit","short","deployedAt"}`、dist ごと gitignore 済み）をビルド後に生成
4. `npx wrangler deploy` を実行

## 成功時の動作

wrangler deploy 成功後、`deploy-<UTC日時>-<短縮コミットハッシュ>`（例: `deploy-20260718-123456Z-6c8f88d`）という annotated タグが自動作成され、origin へ push される。

## 理由

AGPL-3.0 第 13 条対応。ネットワーク越しにサービスを提供する稼働版と公開ソースの対応関係を、デプロイごとの Git タグで証明するため。

## 失敗時の対処

- 「未コミットの変更があります」→ 変更を commit するか `git stash` してから再実行
- 「HEAD が origin/main に含まれていません」→ main へマージして `git push` してから再実行
