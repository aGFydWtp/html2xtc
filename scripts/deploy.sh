#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 aGFydWtp
#
# 正規デプロイスクリプト。
# AGPL-3.0 対応のため、稼働版（デプロイされたコード）と公開ソースの対応を
# Git タグで証明できる状態を技術的に担保する。
#   1. 作業ツリーがクリーンであること
#   2. HEAD が origin/main に push 済みであること
# を検証してから wrangler deploy を実行し、成功時に deploy-<UTC日時> の
# annotated タグを作成して origin へ push する。

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# 検証1: 作業ツリーがクリーンか
if [[ -n "$(git status --porcelain)" ]]; then
  echo "エラー: 作業ツリーに未コミットの変更があります。" >&2
  echo "AGPL-3.0 対応のため、デプロイされる稼働版と公開ソース（Git 履歴）が" >&2
  echo "完全に一致している必要があります。変更を commit するか stash してから" >&2
  echo "再実行してください。" >&2
  exit 1
fi

# 検証2: HEAD が origin/main に含まれているか
git fetch origin main
if ! git merge-base --is-ancestor HEAD origin/main; then
  echo "エラー: HEAD が origin/main に含まれていません。" >&2
  echo "デプロイするコミットは公開リポジトリに存在している必要があります。" >&2
  echo "先に git push してください（main 以外のブランチにいる場合は main へ" >&2
  echo "マージして push してから再実行）。" >&2
  exit 1
fi

# 検証通過後: フロントエンド（Vite + Svelte）をビルドする
# （frontend/node_modules・frontend/dist は .gitignore 済みのため
#   検証1のクリーン判定には影響しない）
npm ci --prefix frontend
npm run build --prefix frontend

# ビルド後: 稼働コミットを WebUI に表示するための version.json を dist へ生成
# （ビルドは dist を作り直すため、必ずビルドの後に書く。frontend/dist は
#   .gitignore 済みのためクリーン判定には影響しない。
#   AGPL-3.0 第 13 条対応: 利用者が稼働中バージョンに対応するソースを特定できるようにする）
HEAD_HASH="$(git rev-parse HEAD)"
SHORT_HASH="$(git rev-parse --short HEAD)"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"commit":"%s","short":"%s","deployedAt":"%s"}\n' \
  "${HEAD_HASH}" "${SHORT_HASH}" "${DEPLOYED_AT}" > frontend/dist/version.json

# デプロイ本体
npx wrangler deploy

# 成功時: デプロイ対応タグを作成して push
TAG="deploy-$(date -u +%Y%m%d-%H%M%SZ)-$(git rev-parse --short HEAD)"

if ! git tag -a "${TAG}" -m "wrangler deploy: ${HEAD_HASH}"; then
  echo "" >&2
  echo "エラー: デプロイ自体は完了していますが、タグの作成に失敗しました。" >&2
  echo "AGPL 対応の記録を残すため、以下を手動で実行してください:" >&2
  echo "  git tag -a \"${TAG}\" -m \"wrangler deploy: ${HEAD_HASH}\"" >&2
  echo "  git push origin \"${TAG}\"" >&2
  exit 1
fi

if ! git push origin "${TAG}"; then
  echo "" >&2
  echo "エラー: デプロイ自体は完了し、ローカルタグ ${TAG} は作成済みですが、" >&2
  echo "タグの push に失敗しました。以下を再実行してください:" >&2
  echo "  git push origin \"${TAG}\"" >&2
  exit 1
fi

echo ""
echo "デプロイ完了: タグ ${TAG}（commit ${HEAD_HASH}）を作成し origin へ push しました。"
