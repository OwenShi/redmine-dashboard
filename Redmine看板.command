#!/usr/bin/env bash
# 双击启动 Redmine 个人看板 —— 在终端窗口前台运行，关窗口即停服务
# 可放在任意位置双击使用（目录自动定位，需先配好 redmine CLI）
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HOME/.redmine-cli.yaml"

# ── 从 redmine CLI 配置读取 server 和 key ──
if [ ! -f "$CONFIG" ]; then
  echo "未找到 $CONFIG"
  echo "请先运行一次 redmine auth login 配置好 redmine CLI"
  echo "按回车退出…"
  read
  exit 1
fi

export REDMINE_URL
export REDMINE_API_KEY
REDMINE_URL=$(grep -E '^\s*server:' "$CONFIG" | head -1 | sed 's/.*server:\s*//' | tr -d '"' | tr -d "'")
REDMINE_API_KEY=$(grep -E '^\s*api_key:' "$CONFIG" | head -1 | sed 's/.*api_key:\s*//' | tr -d '"' | tr -d "'")

if [ -z "$REDMINE_API_KEY" ]; then
  echo "未能从 $CONFIG 读取 api_key"
  echo "按回车退出…"
  read
  exit 1
fi

export PORT="${PORT:-7788}"

# 停掉占用端口的旧进程
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，正在停掉旧进程…"
  lsof -ti:"$PORT" | xargs kill 2>/dev/null || true
  sleep 1
fi

# 后台启动服务，记下 PID
node "$DIR/server.js" &
SERVER_PID=$!

# 等端口就绪后开浏览器（最多等 8 秒）
for i in $(seq 1 16); do
  if lsof -ti:"$PORT" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
open "http://localhost:$PORT"

echo ""
echo "═══════════════════════════════════════"
echo "  Redmine 看板已在浏览器打开"
echo "  关闭本窗口即可停止服务"
echo "  或按 Ctrl+C 停止"
echo "═══════════════════════════════════════"
echo ""

# 等待服务进程：它退出或本窗口被关闭（SIGHUP）时，确保 node 也一起退出
cleanup() {
  echo ""
  echo "正在停止看板服务…"
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait "$SERVER_PID"
