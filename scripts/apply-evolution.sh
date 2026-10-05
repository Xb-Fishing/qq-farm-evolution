#!/usr/bin/env bash
# 应用活动进化（薄壳）：实际动作全部在 core/scripts/evolution-apply-process.js。
# 该 helper 只停当前 Bot 已证明的后代（排除 updater 自身祖先分支，updater 必须
# survive 才能执行重启），以捕获的 argv/env/cwd 结构化 spawn 重启，写应用回执并
# 实测端口就绪；绝不 pkill 全仓、绝不 C-c 整个 tmux pane（防误伤旁观实例）。
set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN_DIR="${FARM_NODE_BIN_DIR:-$(dirname -- "$(command -v node)")}"

exec "${NODE_BIN_DIR}/node" "$REPO_ROOT/core/scripts/evolution-apply-process.js" \
  --bot-pid "${FARM_APPLY_BOT_PID:?missing bot pid}" \
  --bot-starttime "${FARM_APPLY_BOT_STARTTIME:?missing bot starttime}" \
  --expected-head "${FARM_EVOLUTION_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}" \
  --tmux-target "${FARM_TMUX_TARGET:?missing tmux target}" \
  --data-dir "${FARM_DATA_DIR:-$REPO_ROOT/core/data}" \
  --admin-port "${FARM_ADMIN_PORT:-3007}" \
  --node-bin-dir "$NODE_BIN_DIR" \
  ${FARM_APPLY_AUTONOMY:+--autonomy 1}
