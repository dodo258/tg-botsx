#!/usr/bin/env bash
# 在自己电脑上一条命令部署到 Cloudflare Workers。需要 Node.js 22.18 以上。
# Wrangler 会自动创建 D1 数据库并写回配置；Token 存成加密 Secret，不进文件。
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js：https://nodejs.org"; exit 1; }
npm ci --silent

if ! npx wrangler whoami 2>/dev/null | grep -q "associated with the email"; then
  echo "先登录 Cloudflare，浏览器会弹出授权页。"
  npx wrangler login
fi

if [ -z "${BOT_TOKEN:-}" ]; then
  echo "还没有机器人的话：在 Telegram 打开 @BotFather，发 /newbot。"
  read -r -s -p "粘贴 Bot Token（输入时不显示）: " BOT_TOKEN
  echo
fi

# 不能捕获输出：捕获后 wrangler 变成非交互，新账号注册 workers.dev 子域的确认会默认选否
npx wrangler deploy
printf '%s' "$BOT_TOKEN" | npx wrangler secret put BOT_TOKEN

echo
echo "部署完成。打开上面输出里的 workers.dev 地址，贴一次 Token，点认领链接就好了。"
