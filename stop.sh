#!/usr/bin/env bash
# 停止 QQ 农场：杀干净所有相关进程（主进程 / fork 的 worker / pnpm 包装层），并验证面板端口已释放
set -u

BOT_PORT="${ADMIN_PORT:-3007}"

collect_pids() {
    {
        pgrep -f "node client.js" 2>/dev/null
        pgrep -f "pnpm -C core dev" 2>/dev/null
    } | sort -u
}

pids=$(collect_pids | tr '\n' ' ')
if [ -z "${pids// /}" ]; then
    echo "[INFO] 没有发现 QQ 农场相关进程"
else
    echo "[INFO] 正在停止: $pids"
    kill $pids 2>/dev/null

    # 等 2 秒，仍存活的强杀
    sleep 2
    remain=$(collect_pids | tr '\n' ' ')
    if [ -n "${remain// /}" ]; then
        echo "[WARN] 仍有残留进程，强制结束: $remain"
        kill -9 $remain 2>/dev/null
        sleep 1
    fi
fi

# 验证端口已释放
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$BOT_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[WARN] 端口 $BOT_PORT 仍被占用:"
    lsof -nP -iTCP:"$BOT_PORT" -sTCP:LISTEN
    exit 1
fi

echo "[OK] 已全部停止，端口 $BOT_PORT 空闲"
