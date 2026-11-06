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
#   BOT_TOKENS          多个机器人的 Token，空格或换行分开；第一个是默认机器人
#   TGBOTSX_YES=1       所有确认都按「是」
#   WEB_MODE            网页管理：off 不要、port 没有域名、domain 用 WEB_DOMAIN。不设置就问
#   WEB_DOMAIN          网页管理用的域名，自动申请 Let's Encrypt 证书
#   WEB_PORT、WEB_URL   放在 Cloudflare 或自己的反代后面时，指定端口和对外地址
set -euo pipefail

REPO="${TGBOTSX_REPO:-dodo258/tg-botsx}"
BRANCH="${TGBOTSX_BRANCH:-main}"
DIR="${TGBOTSX_DIR:-/opt/tg-botsx}"
MANAGE="tgbot"
MORE_TOKENS=""
NO_TOKEN=""
WEB_CHOICE="${WEB_MODE:-}"
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
    cp -R "$TGBOTSX_SOURCE/src" "$TGBOTSX_SOURCE/package.json" "$TGBOTSX_SOURCE/Dockerfile" "$TGBOTSX_SOURCE/.dockerignore" "$TGBOTSX_SOURCE/docker-compose.yml" "$TGBOTSX_SOURCE/docker-compose.web.yml" "$TGBOTSX_SOURCE/docker-compose.caddy.yml" "$TGBOTSX_SOURCE/.env.example" "$staging/"
    cp -R "$TGBOTSX_SOURCE/deploy" "$staging/deploy"
  else
    curl -fsSL --max-time 120 "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components=1 -C "$staging" || die "下载程序失败。服务器能访问 GitHub 吗？"
  fi
  [ -f "$staging/src/runtime/node.ts" ] || die "下载到的文件不完整。"
  # 只替换程序文件。.env 和数据卷都不碰，也不做任何镜像式删除
  rm -rf "$DIR/src"
  cp -R "$staging/src" "$DIR/src"
  for file in package.json Dockerfile .dockerignore docker-compose.yml docker-compose.web.yml docker-compose.caddy.yml .env.example; do
    cp "$staging/$file" "$DIR/$file"
  done
  cp "$staging/deploy/Caddyfile" "$DIR/Caddyfile"
  install -m 755 "$staging/deploy/tgbot" /usr/local/bin/tgbot
  rm -rf "$staging"
  say "程序在 $DIR"
}

configure_token() {
  step "配置机器人"
  local env_file="$DIR/.env" token="${BOT_TOKEN:-}" reply attempts=0
  if [ -n "${BOT_TOKENS:-}" ]; then
    # shellcheck disable=SC2086
    set -- $BOT_TOKENS
    token="$1"
    shift
    MORE_TOKENS="$*"
  fi
  # 不填 Token 装的网页版：更新和重跑安装时沿用现有配置，不要再问 Token
  if [ -z "$token" ] && [ -f "$env_file" ] && ! grep -q '^BOT_TOKEN=.' "$env_file" && grep -q '^COMPOSE_FILE=.*\(web\|caddy\)' "$env_file"; then
    say "沿用现有配置，机器人在网页上管理。"
    NO_TOKEN=1
    return 0
  fi
  if [ -z "$token" ] && [ -f "$env_file" ]; then
    token="$(sed -n 's/^BOT_TOKEN=//p' "$env_file" | head -n 1)"
    [ -n "$token" ] && say "沿用现有配置里的 Token。"
  fi
  while :; do
    if [ -z "$token" ]; then
      say "还没有机器人的话：在 Telegram 打开 @BotFather，发 /newbot，按提示取名，它会给你一串 Token。"
      if [ "$WEB_CHOICE" = "domain" ] || [ "$WEB_CHOICE" = "port" ]; then
        say "粘贴 Bot Token（输入时不显示），可以一次粘贴多个，一行一个。也可以直接回车跳过，部署好到网页上添加："
      else
        say "粘贴 Bot Token（输入时不显示），可以一次粘贴多个，一行一个，粘贴完再按一次回车："
      fi
      local line
      local received=0
      while IFS= read -r -s line < /dev/tty; do
        [ -n "$line" ] || break
        received=$((received + 1))
        say "已收到第 $received 个。继续粘贴下一个，或者直接回车结束。"
        if [ -z "$token" ]; then token="$line"; else MORE_TOKENS="$MORE_TOKENS $line"; fi
      done
      if [ -z "$token" ]; then
        # 开了网页就可以部署好再去网页上加
        if [ "$WEB_CHOICE" = "domain" ] || [ "$WEB_CHOICE" = "port" ]; then
          say "先不加机器人，部署好到网页上添加。"
          NO_TOKEN=1
          return 0
        fi
        die "读不到输入。可以用 BOT_TOKEN=xxx 环境变量运行。"
      fi
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
        say "连不上 Telegram（$API_BASE）。国内服务器通常连不上，要在 $env_file 里配代理或反代。"
        say "写法：HTTPS_PROXY=http://host.docker.internal:7890 和 NODE_USE_ENV_PROXY=1 两行，或者 TELEGRAM_API_BASE=https://你的反代域名。"
        # .env 里已有的 Token 只是这会儿校验不了，不用让人重新粘贴（比如更新时网络抖动）
        if [ -f "$env_file" ] && { grep -q '^HTTPS_PROXY=' "$env_file" || grep -qxF "BOT_TOKEN=$token" "$env_file"; }; then
          say "先跳过这一步校验，用 .env 里已有的配置继续。"
          BOT_NAME=""
          break
        fi
        ;;
    esac
    attempts=$((attempts + 1))
    [ "$attempts" -ge 3 ] && die "试了 3 次都不行。解决后重新运行这个脚本，已有的文件不会丢。"
    [ -n "${BOT_TOKEN:-}${BOT_TOKENS:-}" ] && die "环境变量里的 Token 不可用。"
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

# 第一次安装时问一次。只跑一个机器人不需要网页，默认不开，也就不开任何端口
choose_web() {
  # 从开了网页的旧版本更新：端口配置在，但还没有 COMPOSE_FILE
  if [ -f "$DIR/.env" ] && grep -q '^WEB_PORT=' "$DIR/.env" && ! grep -q '^COMPOSE_FILE=' "$DIR/.env"; then
    printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.web.yml\n' >> "$DIR/.env"
  fi
  if [ -f "$DIR/.env" ] && grep -q '^BOT_TOKEN=\|^COMPOSE_FILE=' "$DIR/.env"; then
    WEB_CHOICE="${WEB_CHOICE:-keep}"
    return
  fi
  if [ -n "$WEB_CHOICE" ]; then return; fi
  if [ "${TGBOTSX_YES:-}" = "1" ] || [ ! -r /dev/tty ]; then
    WEB_CHOICE=off
    return
  fi
  step "网页管理（可选）"
  say "在浏览器里添加机器人、指定管理员。要给多个人开机器人，用它会方便很多；只跑一个机器人可以不要。"
  say "  1) 要，用我自己的域名（推荐：自动申请 Let's Encrypt 免费证书，到期自动续）"
  say "  2) 要，但我没有域名（用自签名证书，第一次打开浏览器会提示不安全）"
  say "  3) 不要（只跑一个机器人，服务器不开任何端口）"
  local answer
  while :; do
    read -r -p "选择 [1]: " answer < /dev/tty || answer=3
    case "${answer:-1}" in
      1)
        say "先把域名解析到这台服务器，并在云服务商的防火墙放行 80 和 443 端口。直接回车可以回去重选。"
        read -r -p "域名（比如 bot.example.com）: " WEB_DOMAIN < /dev/tty || WEB_DOMAIN=""
        if [ -n "$WEB_DOMAIN" ]; then
          WEB_CHOICE=domain
          return
        fi
        ;;
      2) WEB_CHOICE=port; return ;;
      3) WEB_CHOICE=off; return ;;
      *) say "请输入 1、2 或 3。" ;;
    esac
  done
}

apply_web() {
  case "$WEB_CHOICE" in
    domain) step "网页管理"; TGBOTSX_DIR="$DIR" /usr/local/bin/tgbot web on "$WEB_DOMAIN" || say "网页管理没开成，机器人不受影响。看上面的原因，解决后运行 tgbot web on $WEB_DOMAIN。" ;;
    port) step "网页管理"; TGBOTSX_DIR="$DIR" /usr/local/bin/tgbot web on || say "网页管理没开成，机器人不受影响。稍后运行 tgbot web on。" ;;
    *) ;;
  esac
}

add_more_bots() {
  [ -n "$MORE_TOKENS" ] || return 0
  step "添加其他机器人"
  local token
  for token in $MORE_TOKENS; do
    printf '%s\n' "$token" | (cd "$DIR" && docker compose exec -T bot node --disable-warning=ExperimentalWarning dist/runtime/node.js add) || say "这个 Token 没加上，看上面的原因。"
  done
  say "把机器人的用户名发给要用的人，对方私聊机器人，点「成为管理员」就好了。"
}

start_bot() {
  step "启动机器人"
  # 没有机器人时程序靠网页才有事可做，基础配置下会直接退出，所以先把网页配置带上
  if [ -n "$NO_TOKEN" ] && ! grep -q '^COMPOSE_FILE=.*\(web\|caddy\)' "$DIR/.env" 2>/dev/null; then
    (
      umask 077
      touch "$DIR/.env"
      grep -q '^WEB_PORT=' "$DIR/.env" || printf 'WEB_PORT=%s\n' "${WEB_PORT:-$(( ( $(od -An -N2 -tu2 /dev/urandom) % 40000 ) + 20000 ))}" >> "$DIR/.env"
      grep -v '^COMPOSE_FILE=' "$DIR/.env" > "$DIR/.env.tmp" || true
      printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.web.yml\n' >> "$DIR/.env.tmp"
      cat "$DIR/.env.tmp" > "$DIR/.env"
      rm -f "$DIR/.env.tmp"
      chmod 600 "$DIR/.env"
    )
  fi
  (cd "$DIR" && docker compose up -d --build --remove-orphans) || die "启动失败，请看上面的报错。"
  local waited=0
  local ready='已连接'
  [ -z "$NO_TOKEN" ] || ready='传声筒已启动'
  until (cd "$DIR" && docker compose logs bot 2>/dev/null | grep -q "$ready"); do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge 60 ]; then
      (cd "$DIR" && docker compose logs --tail=20 bot) || true
      die "机器人 60 秒内没有连上 Telegram，日志在上面。"
    fi
  done
  if [ -n "$NO_TOKEN" ]; then say "程序已启动。"; else say "机器人已连上 Telegram。"; fi
}

show_claim() {
  [ -z "$NO_TOKEN" ] || return 0
  step "最后一步：绑定管理员"
  local logs="" link="" state="" waited=0
  # 开网页时容器刚重建，要等它连上才查得到。不能把「还没连上」当成「已经绑定过」
  while [ "$waited" -lt 30 ]; do
    state="$( (cd "$DIR" && docker compose exec -T bot node --disable-warning=ExperimentalWarning dist/runtime/node.js list </dev/null 2>/dev/null) | grep '^默认' | cut -f3 || true)"
    case "$state" in
      已绑定*)
        say "已经绑定过管理员了。要换人的话运行：$MANAGE claim"
        return 0
        ;;
      绑定已过期*)
        say "绑定已过期。运行 $MANAGE claim 重新生成。"
        return 0
        ;;
      *) ;;
    esac
    logs="$(cd "$DIR" && docker compose logs bot 2>/dev/null)"
    link="$(printf '%s\n' "$logs" | grep -o 'https://t.me/[^ ]*start=claim_[A-Za-z0-9_-]*' | tail -n 1 || true)"
    [ -z "$link" ] || break
    sleep 1
    waited=$((waited + 1))
  done
  if [ -z "$link" ]; then
    say "还没拿到绑定方式。稍后运行 $MANAGE claim 生成。"
    return 0
  fi
  local username pair
  pair="$(printf '%s\n' "$logs" | grep -o '配对图案：.*' | tail -n 1 | sed 's/^配对图案：//' | tr -d '[:cntrl:]' || true)"
  username="$(printf '%s' "$link" | sed -n 's#^https://t.me/\([^?]*\)?.*#\1#p')"
  say "用你要当管理员的 Telegram 账号打开 @$username，点「开始」，再点和下面一样的图案（7 天内有效）："
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
  [ -t 1 ] && [ -z "$MORE_TOKENS" ] || return 0
  say ""
  say "等你点图案…不想等可以按 Ctrl+C，机器人不受影响。"
  local waited=0 who logs_now
  while [ "$waited" -lt 600 ]; do
    logs_now="$( (cd "$DIR" && docker compose logs --no-log-prefix bot 2>/dev/null) || true)"
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
  say "还没有人绑定，机器人继续等。以后运行 $MANAGE list 查看。"
}

main() {
  need_root "$@"
  ensure_tools
  ensure_docker
  mkdir -p "$DIR"
  choose_web
  # 先校验 Token 再动程序文件，校验不过时现有版本不受影响
  configure_token
  fetch_source
  start_bot
  apply_web
  add_more_bots
  show_claim
  step "装好了"
  [ "$WEB_CHOICE" != "off" ] || say "以后想用网页管理，运行 tgbot web on。"
  say "以后管理机器人运行：$MANAGE"
  say "其他操作都在 Telegram 里：给机器人发 /start 打开管理面板，点按钮就行。"
}

main "$@"
