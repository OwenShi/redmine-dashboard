#!/usr/bin/env bash
# 一键启动 Redmine 个人看板
# 自动读取 ~/.redmine-cli.yaml 里的 server 和 api_key，无需手动配置
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HOME/.redmine-cli.yaml"

# ── 从 redmine CLI 配置读取 server 和 key ──
if [ ! -f "$CONFIG" ]; then
  echo "未找到 $CONFIG"
  echo "请先运行一次 redmine auth login 配置好 redmine CLI"
  exit 1
fi

config_value() {
  local key="$1"
  sed -n "s/^[[:space:]]*${key}:[[:space:]]*//p" "$CONFIG" |
    head -1 |
    tr -d "\"'" |
    sed 's/[[:space:]]*$//'
}

export REDMINE_URL
export REDMINE_API_KEY
REDMINE_URL=$(config_value server)
REDMINE_API_KEY=$(config_value api_key)

if [ -z "$REDMINE_API_KEY" ]; then
  echo "未能从 $CONFIG 读取 api_key"
  exit 1
fi

export PORT="${PORT:-7788}"

# ── 检查端口占用，提示或停掉旧进程 ──
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，正在停掉旧进程…"
  lsof -ti:"$PORT" | xargs kill 2>/dev/null || true
  sleep 1
fi

echo "启动看板… (Ctrl+C 停止)"
exec node "$DIR/server.js"
