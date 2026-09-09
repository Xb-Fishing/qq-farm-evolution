#!/usr/bin/env bash
# 应用活动进化：只在当前 Bot 进程所属的既有 tmux pane 里重启，不新建窗口/会话。
set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMUX_TARGET="${FARM_TMUX_TARGET:-}"
NODE_BIN_DIR="${FARM_NODE_BIN_DIR:-$(dirname -- "$(command -v node)")}"

# 目标由父进程根据 Bot PID 反查得到；没有目标时禁止猜 pane，避免重启错误会话。
# 旧版 FARM_TMUX_TARGET:-farm:0.0 仅作迁移提示，当前绝不回退到固定 pane。
if [[ -z "$TMUX_TARGET" ]]; then
  echo "[ERROR] 未提供当前 Bot 所属的 tmux pane，取消重启" >&2
  exit 1
fi

# 必须在停旧进程前先验证 pane；不存在就原样保持运行。
tmux display-message -p -t "$TMUX_TARGET" '#{pane_id}' >/dev/null

sleep 2
cd "$REPO_ROOT"
bash stop.sh >/dev/null 2>&1

printf -v repo_quoted '%q' "$REPO_ROOT"
printf -v node_bin_quoted '%q' "$NODE_BIN_DIR"
start_command="cd $repo_quoted && PATH=$node_bin_quoted:\$PATH bash start.sh"

# 只复用已有 pane；send-keys -l 防止命令文本在发送前被展开。
tmux send-keys -t "$TMUX_TARGET" C-c
tmux send-keys -t "$TMUX_TARGET" -l -- "$start_command"
tmux send-keys -t "$TMUX_TARGET" C-m
