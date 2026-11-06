#!/usr/bin/env bash
# 传声筒服务器一键安装。需要 Linux 和 root 权限，会用 Docker 跑机器人。
# 重复运行是安全的：已有的 Token 和数据都会保留。
#
# 可用环境变量（非交互部署时用）：
#   BOT_TOKEN           机器人 Token，不设置就提示输入
#   TELEGRAM_API_BASE   自建的 Bot API 反代地址
#   TGBOTSX_REPO        下载源码的仓库，默认 dodo258/tg-botsx
#   TGBOTSX_SOURCE      用本地目录当源码，不下载
#   TGBOTSX_DIR         安装目录，默认 /opt/tg-botsx
#   TGBOTSX_NAME        机器人的名字，tgbot add 新增机器人时传入，只影响提示文字
#   TGBOTSX_YES=1       所有确认都按「是」
set -euo pipefail

REPO="${TGBOTSX_REPO:-dodo258/tg-botsx}"
BRANCH="${TGBOTSX_BRANCH:-main}"
DIR="${TGBOTSX_DIR:-/opt/tg-botsx}"
MANAGE="tgbot${TGBOTSX_NAME:+ $TGBOTSX_NAME}"
# 从 tgbot update 调用时可能继承 umask 077，程序文件必须让容器里的 node 用户读得到
umask 022

# 环境变量优先，其次已有配置里的反代地址。国内服务器更新时靠这个连上 Telegram
env_api_base() {
  [ -f "$DIR/.env" ] && sed -n 's/^TELEGRAM_API_BASE=//p' "$DIR/.env" | head -n 1
  return 0
}
API_BASE="${TELEGRAM_API_BASE:-$(env_api_base)}"
API_BASE="${API_BASE:-https://api.telegram.org}"
API_BASE="${API_BASE%/}"

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n错误：%s\n' "$*" >&2; exit 1; }

ask_yes() {
  [ "${TGBOTSX_YES:-}" = "1" ] && return 0
  local answer
  read -r -p "$1 [Y/n] " answer < /dev/tty || return 1
  case "$answer" in ''|y|Y|yes|是) return 0 ;; *) return 1 ;; esac
}

# 用 curl 配置文件传地址，Token 不会出现在 ps 能看到的命令行里
call_get_me() {
  printf 'url = "%s/bot%s/getMe"\n' "$API_BASE" "$1" | curl -sS --max-time 15 -K - 2>/dev/null
}

need_root() {
  [ "$(id -u)" -eq 0 ] && return 0
  command -v sudo >/dev/null 2>&1 || die "需要 root 权限，请用 root 用户运行。"
  [ -f "$0" ] || die "需要 root 权限。请先 sudo -i 切到 root，再运行安装命令。"
  exec sudo -E bash "$0" "$@"
}

ensure_tools() {
  command -v curl >/dev/null 2>&1 || die "没有 curl。Debian/Ubuntu 上运行：apt install -y curl"
  command -v tar >/dev/null 2>&1 || die "没有 tar。Debian/Ubuntu 上运行：apt install -y tar"
}

ensure_docker() {
  step "检查 Docker"
  if ! command -v docker >/dev/null 2>&1; then
    say "这台服务器还没有 Docker。"
    ask_yes "用 Docker 官方脚本（get.docker.com）安装？" || die "没有 Docker 无法继续。也可以按 README 不用 Docker 部署。"
    local installer
    installer="$(mktemp)"
    curl -fsSL --max-time 60 https://get.docker.com -o "$installer" || die "下载 Docker 安装脚本失败，请检查网络。"
    sh "$installer" || die "Docker 安装失败，请看上面的报错。"
    rm -f "$installer"
  fi
  docker info >/dev/null 2>&1 || { systemctl start docker 2>/dev/null || true; sleep 2; docker info >/dev/null 2>&1 || die "Docker 没有在运行。试试 systemctl start docker。"; }
  docker compose version >/dev/null 2>&1 || die "缺少 Docker Compose 插件。Debian/Ubuntu 上运行：apt install -y docker-compose-plugin"
  say "Docker 正常。"
}

fetch_source() {
  step "准备程序文件"
  local staging
  staging="$(mktemp -d)"
  if [ -n "${TGBOTSX_SOURCE:-}" ]; then
    cp -R "$TGBOTSX_SOURCE/src" "$TGBOTSX_SOURCE/package.json" "$TGBOTSX_SOURCE/Dockerfile" "$TGBOTSX_SOURCE/.dockerignore" "$TGBOTSX_SOURCE/docker-compose.yml" "$TGBOTSX_SOURCE/.env.example" "$staging/"
    cp -R "$TGBOTSX_SOURCE/deploy" "$staging/deploy"
  else
    curl -fsSL --max-time 120 "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components=1 -C "$staging" || die "下载程序失败。服务器能访问 GitHub 吗？"
  fi
  [ -f "$staging/src/runtime/node.ts" ] || die "下载到的文件不完整。"
  # 只替换程序文件。.env 和数据卷都不碰，也不做任何镜像式删除
  rm -rf "$DIR/src"
  cp -R "$staging/src" "$DIR/src"
  for file in package.json Dockerfile .dockerignore docker-compose.yml .env.example; do
    cp "$staging/$file" "$DIR/$file"
  done
  install -m 755 "$staging/deploy/tgbot" /usr/local/bin/tgbot
  rm -rf "$staging"
  say "程序在 $DIR"
}

configure_token() {
  step "配置机器人"
  local env_file="$DIR/.env" token="${BOT_TOKEN:-}" reply attempts=0
  if [ -z "$token" ] && [ -f "$env_file" ]; then
    token="$(sed -n 's/^BOT_TOKEN=//p' "$env_file" | head -n 1)"
    [ -n "$token" ] && say "沿用现有配置里的 Token。"
  fi
  while :; do
    if [ -z "$token" ]; then
      say "还没有机器人的话：在 Telegram 打开 @BotFather，发 /newbot，按提示取名，它会给你一串 Token。"
      read -r -s -p "粘贴 Bot Token（输入时不显示）: " token < /dev/tty || die "读不到输入。可以用 BOT_TOKEN=xxx 环境变量运行。"
      printf '\n'
    fi
    reply="$(call_get_me "$token" || true)"
    case "$reply" in
      *'"ok":true'*)
        BOT_NAME="$(printf '%s' "$reply" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
        say "Token 有效，机器人是 @$BOT_NAME"
        break
        ;;
      *'"error_code":401'*)
        say "Telegram 说这个 Token 不对。去 @BotFather 发 /token 核对。"
        ;;
      *)
        say "连不上 Telegram（$API_BASE）。国内服务器通常连不上，要用代理或反代，见 .env.example。"
        if [ -f "$env_file" ] && grep -q '^HTTPS_PROXY=' "$env_file"; then
          say "检测到 .env 里配了代理，跳过这一步校验。"
          BOT_NAME=""
          break
        fi
        ;;
    esac
    attempts=$((attempts + 1))
    [ "$attempts" -ge 3 ] && die "试了 3 次都不行。解决后重新运行这个脚本，已有的文件不会丢。"
    [ -n "${BOT_TOKEN:-}" ] && die "环境变量里的 BOT_TOKEN 不可用。"
    token=""
  done
  (
    umask 077
    if [ -f "$env_file" ]; then
      # 只改 Token 这一行，其他配置（代理等）保留
      updated="$(mktemp)"
      grep -v '^BOT_TOKEN=' "$env_file" > "$updated" || true
      printf 'BOT_TOKEN=%s\n' "$token" >> "$updated"
      cat "$updated" > "$env_file"
      rm -f "$updated"
    else
      printf 'BOT_TOKEN=%s\n' "$token" > "$env_file"
    fi
    if [ "${TELEGRAM_API_BASE:-}" != "" ] && ! grep -q '^TELEGRAM_API_BASE=' "$env_file"; then
      printf 'TELEGRAM_API_BASE=%s\n' "$API_BASE" >> "$env_file"
    fi
    chmod 600 "$env_file"
  )
}

start_bot() {
  step "启动机器人"
  (cd "$DIR" && docker compose up -d --build --remove-orphans) || die "启动失败，请看上面的报错。"
  local waited=0
  until (cd "$DIR" && docker compose logs bot 2>/dev/null | grep -q '已连接'); do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge 60 ]; then
      (cd "$DIR" && docker compose logs --tail=20 bot) || true
      die "机器人 60 秒内没有连上 Telegram，日志在上面。"
    fi
  done
  say "机器人已连上 Telegram。"
}

show_claim() {
  step "最后一步：绑定管理员"
  local logs link
  logs="$(cd "$DIR" && docker compose logs bot 2>/dev/null)"
  link="$(printf '%s\n' "$logs" | grep -o 'https://t.me/[^ ]*start=claim_[A-Za-z0-9_-]*' | tail -n 1 || true)"
  if [ -z "$link" ]; then
    say "已经绑定过管理员了。要换人的话运行：$MANAGE claim"
    return
  fi
  local username pair
  pair="$(printf '%s\n' "$logs" | grep -o '配对图案：.*' | tail -n 1 | sed 's/^配对图案：//' | tr -d '[:cntrl:]' || true)"
  username="$(printf '%s' "$link" | sed -n 's#^https://t.me/\([^?]*\)?.*#\1#p')"
  say "用你要当管理员的 Telegram 账号打开 @$username，点「开始」，再点和下面一样的图案（10 分钟内有效）："
  say ""
  say "  配对图案：$pair"
  say "  机器人：https://t.me/$username"
  say ""
  say "只有一次机会，点错按钮就失效，这时用这个链接绑定：$link"
  say "都过期了运行 $MANAGE claim 重新生成。"
  wait_for_owner
}

# 按钮谁都能看到，让部署的人亲眼看到是谁绑定的。没有终端（脚本部署）时不等
wait_for_owner() {
  [ -t 1 ] || return 0
  say ""
  say "等你点图案…不想等可以按 Ctrl+C，机器人不受影响。"
  local waited=0 who logs_now
  while [ "$waited" -lt 600 ]; do
    logs_now="$(cd "$DIR" && docker compose logs --no-log-prefix bot 2>/dev/null || true)"
    who="$(printf '%s\n' "$logs_now" | grep -o '已绑定管理员：.*' | tail -n 1 | tr -d '[:cntrl:]' || true)"
    if [ -z "$who" ] && printf '%s\n' "$logs_now" | grep -q '绑定按钮已失效'; then
      say "有人点错了图案，按钮已失效。如果不是你点的，说明有人在抢这个机器人。用上面的链接绑定，或运行 $MANAGE claim 换新图案。"
      return 0
    fi
    if [ -n "$who" ]; then
      say "$who"
      say "不是你本人的话，马上运行 $MANAGE claim，用新链接换回来。"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  say "10 分钟内没有人绑定，运行 $MANAGE claim 重新生成。"
}

main() {
  need_root "$@"
  ensure_tools
  ensure_docker
  mkdir -p "$DIR"
  # 先校验 Token 再动程序文件，校验不过时现有版本不受影响
  configure_token
  fetch_source
  start_bot
  show_claim
  step "装好了"
  say "以后管理机器人运行：$MANAGE"
  say "其他操作都在 Telegram 里：给机器人发 /start 打开管理面板，点按钮就行。"
}

main "$@"
