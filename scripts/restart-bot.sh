#!/usr/bin/env bash
# 确定性重启 bot（2026-09-24）：任何会话/脚本统一走这里，不再依赖 tmux pane 的
# 当前目录与手工 C-c 时序。在 farm 会话 pane 内运行：杀旧→等端口释放→绝对路径启动。
set -u

REPO_ROOT="/data/vepfs/users/xianbao01.hou/qq-farm-bot"

echo "[restart] 1/3 停旧进程"
pkill -f "node client.js" 2>/dev/null
for _ in $(seq 1 20); do
  pgrep -f "node client.js" >/dev/null || break
  sleep 0.5
done
pkill -9 -f "node client.js" 2>/dev/null
# 等待 3007 释放
for _ in $(seq 1 20); do
  ss -tln 2>/dev/null | grep -q ":3007 " || break
  sleep 0.5
done

echo "[restart] 2/3 确保 farm 会话存在并绝对路径启动"
# 会话可能整个消失（node 用 exec 替换 shell 后进程退出会连 pane 一起关掉）：
# 不存在就重建；启动命令不用 exec，保留 shell 作为父进程，node 崩了 pane 还在。
if ! tmux has-session -t farm 2>/dev/null; then
  echo "[restart] farm 会话不存在，重建"
  tmux new-session -d -s farm -c "$REPO_ROOT/core"
  sleep 1
fi
PANE="${1:-$(tmux list-panes -t farm -F '#{pane_id}' 2>/dev/null | head -1)}"
[ -n "$PANE" ] || { echo "[restart] 找不到 farm pane" >&2; exit 1; }
tmux send-keys -t "$PANE" C-c 2>/dev/null
tmux send-keys -t "$PANE" -l -- "cd $REPO_ROOT/core && node client.js"
tmux send-keys -t "$PANE" C-m

echo "[restart] 3/3 等待面板就绪（最长 60s）"
for _ in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:3007/; then
    echo "[restart] 面板已就绪"
    exit 0
  fi
  sleep 1
done
echo "[restart] 超时：面板 60 秒未就绪，请查 farm pane 日志" >&2
exit 1
