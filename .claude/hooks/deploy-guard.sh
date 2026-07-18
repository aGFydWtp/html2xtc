#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 haruki
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

# 正規ルート（scripts/deploy.sh / npm run deploy）は許可
case "$COMMAND" in
  *scripts/deploy.sh*|*"npm run deploy"*)
    exit 0
    ;;
esac

# wrangler deploy / wrangler versions upload / wrangler versions deploy をブロック
# （npx/bunx 経由や引数付きも含む）
if printf '%s' "$COMMAND" | grep -Eq 'wrangler[[:space:]]+(deploy|versions[[:space:]]+(upload|deploy))'; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"wrangler deploy の直接実行は禁止です。AGPL-3.0 対応のため、デプロイは必ず `npm run deploy`（scripts/deploy.sh）経由で行い、稼働版に対応する Git タグを自動記録してください。"}}
JSON
  exit 0
fi

exit 0
