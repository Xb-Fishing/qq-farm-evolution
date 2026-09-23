#!/usr/bin/env bash
# 应用活动进化：只在当前 Bot 进程所属的既有 tmux pane 里重启，不新建窗口/会话。
set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMUX_TARGET="${FARM_TMUX_TARGET:-}"
NODE_BIN_DIR="${FARM_NODE_BIN_DIR:-$(dirname -- "$(command -v node)")}"

# web 构建需要 Node >= 20.19（vite 7 硬要求），而 Bot 进程可能跑在系统 Node 18 上
# （2026-09-23 应用进化反复失败的根因）。构建节点独立解析：优先 nvm 下的 v20/v22，
# 找不到再回退 Bot 进程的 node。重启命令仍用 NODE_BIN_DIR，不改变 Bot 运行时。
node_meets_vite() {
  "$1" -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>20||(M===20&&m>=19)?0:1)' >/dev/null 2>&1
}
BUILD_NODE_DIR="$NODE_BIN_DIR"
if ! node_meets_vite "$BUILD_NODE_DIR/node"; then
  for cand in "$HOME"/.nvm/versions/node/v2[02].*/bin; do
    [[ -x "$cand/node" ]] || continue
    if node_meets_vite "$cand/node"; then BUILD_NODE_DIR="$(cd -- "$cand" && pwd)"; break; fi
  done
fi

# 目标由父进程根据 Bot PID 反查得到；没有目标时禁止猜 pane，避免重启错误会话。
# 旧版 FARM_TMUX_TARGET:-farm:0.0 仅作迁移提示，当前绝不回退到固定 pane。
if [[ -z "$TMUX_TARGET" ]]; then
  echo "[ERROR] 未提供当前 Bot 所属的 tmux pane，取消重启" >&2
  exit 1
fi

# 必须在停旧进程前先验证 pane；不存在就原样保持运行。
tmux display-message -p -t "$TMUX_TARGET" '#{pane_id}' >/dev/null

cd "$REPO_ROOT"
APPLY_EXPECTED_HEAD="${FARM_EVOLUTION_COMMIT:-$(git rev-parse HEAD)}"
if [[ "$(git rev-parse HEAD)" != "$APPLY_EXPECTED_HEAD" || -n "$(git status --porcelain)" ]]; then
  echo "[ERROR] 待应用版本或工作区发生变化，取消部署" >&2
  exit 1
fi

# 巡检的构建只用于验证。确认应用后，再隔离构建当前已审提交；失败时不停止旧服务。
umask 077
mkdir -p "$REPO_ROOT/tmp" "${FARM_DATA_DIR:-$REPO_ROOT/core/data}/logs"
EVOLUTION_BUILD_ROOT="$(mktemp -d "$REPO_ROOT/tmp/evolution-apply.XXXXXX")"
cleanup_build() { rm -rf -- "$EVOLUTION_BUILD_ROOT"; }
trap cleanup_build EXIT
APPLY_BUILD_LOG="${FARM_DATA_DIR:-$REPO_ROOT/core/data}/logs/evolve-apply.log"
(
  cd "$REPO_ROOT/web"
  PATH="$BUILD_NODE_DIR:$PATH" npm run build -- --outDir "$EVOLUTION_BUILD_ROOT/dist" --emptyOutDir
) >"$APPLY_BUILD_LOG" 2>&1
test -f "$EVOLUTION_BUILD_ROOT/dist/index.html"
test "$(git rev-parse HEAD)" = "$APPLY_EXPECTED_HEAD"
test -z "$(git status --porcelain)"
tmux display-message -p -t "$TMUX_TARGET" '#{pane_id}' >/dev/null
if [[ -e "$REPO_ROOT/web/dist" ]]; then mv "$REPO_ROOT/web/dist" "$EVOLUTION_BUILD_ROOT/previous-dist"; fi
if ! mv "$EVOLUTION_BUILD_ROOT/dist" "$REPO_ROOT/web/dist"; then
  if [[ -e "$EVOLUTION_BUILD_ROOT/previous-dist" ]]; then mv "$EVOLUTION_BUILD_ROOT/previous-dist" "$REPO_ROOT/web/dist"; fi
  exit 1
fi

sleep 2
bash stop.sh >/dev/null 2>&1

printf -v repo_quoted '%q' "$REPO_ROOT"
printf -v node_bin_quoted '%q' "$NODE_BIN_DIR"
start_command="cd $repo_quoted && PATH=$node_bin_quoted:\$PATH bash start.sh"

# 只复用已有 pane；send-keys -l 防止命令文本在发送前被展开。
tmux send-keys -t "$TMUX_TARGET" C-c
tmux send-keys -t "$TMUX_TARGET" -l -- "$start_command"
tmux send-keys -t "$TMUX_TARGET" C-m
