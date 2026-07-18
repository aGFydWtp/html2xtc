#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 aGFydWtp
#
# Claude Code PreToolUse hook: wrangler deploy 系コマンドの直接実行をブロックし、
# scripts/deploy.sh（npm run deploy）経由のデプロイに誘導する。

set -u

# jq が無い環境では hook がツール実行を壊さないよう黙って許可する
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT="$(cat)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)" || exit 0

# wrangler deploy / wrangler versions upload / wrangler versions deploy をブロック
# （npx/bunx 経由・引数付き・wrangler@<version> 指定も含む）。
# 許可リストは持たない: 正規ルート（npm run deploy / bash scripts/deploy.sh）の
# コマンド文字列自体はこの正規表現にマッチせず、scripts/deploy.sh 内部で動く
# wrangler は hook の対象外なので、マッチ = 常に deny でよい。
if printf '%s' "$COMMAND" | grep -Eq 'wrangler(@[^[:space:]]+)?[[:space:]]+(deploy|versions[[:space:]]+(upload|deploy))'; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"wrangler deploy の直接実行は禁止です。AGPL-3.0 対応のため、デプロイは必ず `npm run deploy`（scripts/deploy.sh）経由で行い、稼働版に対応する Git タグを自動記録してください。"}}
JSON
  exit 0
fi

exit 0
