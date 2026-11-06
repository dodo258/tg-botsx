# 传声筒

中文 Telegram 私人双向机器人。别人给机器人发消息，你在 Telegram 里回复，对方看不到你的账号。机器人是你自己的，不经过任何第三方。

贴一个 Token、在机器人里点一下按钮就能用。不用查数字 ID，不用域名，也不用另开后台，不会打命令也能管理：所有操作都在 Telegram 里点按钮。

## 部署

先在 Telegram 打开 [@BotFather](https://t.me/BotFather)，发 `/newbot`，按提示取名，拿到一串 Token。

部署到自己的服务器，不需要域名，不开端口，数据都在你手里。同一个 Token 只能跑一份。

用 root 运行，需要 Linux。没有 Docker 时脚本会问你要不要装。

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dodo258/tg-botsx/main/deploy/install.sh)
```

脚本会校验 Token，构建并启动机器人。然后在 Telegram 打开你的机器人，点「开始」，再点「成为管理员」就绑定好了，手机和电脑都一样。这个按钮只在第一次绑定时出现，部署后 10 分钟内有效，终端会显示是谁绑定的；不是你本人的话，运行 `tgbot claim` 用新链接换回来。

之后运行 `tgbot` 打开管理菜单：

```text
tgbot status          状态和最近日志
tgbot logs            实时日志
tgbot update          更新到最新版（会先备份）
tgbot backup          备份到 /opt/tg-botsx/backups
tgbot restore 文件    恢复备份
tgbot claim           重新生成认领链接
tgbot token           更换 Token
tgbot uninstall       卸载，默认保留数据
```

服务器连不上 Telegram（国内常见）时，在 `/opt/tg-botsx/.env` 里配代理或反代，写法见 [.env.example](.env.example)，然后 `tgbot restart`。

### 同一台服务器跑多个机器人

要给不同的人各开一个，用 `tgbot add` 新增。每个机器人有自己的 Token、管理员、数据库和备份目录，数据互不相通。

```bash
tgbot add shop
```

名字只能用小写英文字母、数字和连字符。粘贴新机器人的 Token 后，让要当管理员的人打开机器人，点「成为管理员」。给别人开的话，也可以把脚本给的链接发给对方。之后在命令里带上名字：

```text
tgbot shop status     管理 shop，其他命令同上（不写名字就是默认机器人）
tgbot shop            打开 shop 的管理菜单
tgbot list            查看所有机器人
tgbot update-all      更新所有机器人
```

新机器人的文件在 `/opt/tg-botsx-shop`。这里的隔离是机器人之间的：有服务器 root 权限的人能读到所有机器人的 Token 和聊天记录。替别人开之前请告诉对方；不想让你看到的人，应该部署到自己的服务器。

不想用 Docker：需要 Node.js 22.18+（Ubuntu 上用官方压缩包时还要 `apt install libatomic1`），把仓库放到 `/opt/tg-botsx`，写好 `.env`，用 [deploy/tg-botsx.service](deploy/tg-botsx.service) 启动。运行时没有第三方依赖，不用 `npm install`。

## 怎么用

**回复别人**：别人的消息会转到你和机器人的私聊里，回复那条消息就是回复对方。发出去后你的消息上会出现 👌，发不出去会直接告诉你原因，比如对方拉黑了机器人。

**多人协作**：建一个开了「话题」的超级群，在面板的 设置 → 消息收在哪 里点「绑定话题群」，选这个群并确认给机器人管理员权限。没有自动绑定的话，在群里发 `/bindgroup`。之后每个联系人有自己的话题，群里的人都能回复。以 `//` 开头的话只留在群里，不会发给对方。

**管理面板**：点输入框旁边的菜单里的「打开管理面板」，或发 `/start`。首页放常用的：会话、搜索、快捷回复、隔离区、群发、统计、设置；关键词回复、屏蔽名单、清理、导出、运行状态收在「更多」里。全部点按钮。要填内容时机器人会一步步问你，点「取消」随时退出。

**联系人卡片**：每个联系人的卡片上可以点「快捷回复」直接发一句常用的话，点「撤回上一条」撤回刚发的消息，还能看聊天记录、写备注、屏蔽。

习惯打字的话，下面这些命令也都能用：

| 命令 | 作用 |
|---|---|
| `/list` | 最近会话 |
| `/search 关键词` | 按名字、用户名、ID、备注搜索 |
| `/history` | 聊天记录 |
| `/note 内容` | 给联系人写备注 |
| `/block` `/unblock` | 屏蔽和解除 |
| `/del` | 回复自己发的消息来撤回（48 小时内） |
| `/q 名字` | 发快捷回复，`/qadd 名字 内容` 添加 |
| `/filtered` | 隔离区，被拦下的消息可以放行 |
| `/stats` | 收发量、新联系人、平均首次回复时间 |
| `/rule` | 关键词自动回复（主人） |
| `/broadcast` | 回复一条消息后群发（主人） |
| `/status` | 运行状态（主人） |
| `/cleanup` `/export` | 清理和导出数据（主人） |

命令后面可以跟数字 ID，比如 `/history 123456`；不跟就用当前话题、引用的消息或选中的会话。

## 它做了什么

**消息不丢**
- 验证前发的消息先留着，通过后自动转过来，对方不用重发。
- 转发失败（比如被 Telegram 限流）会记下来，定时补发。
- 被拦截的消息进隔离区，不是直接丢弃。
- 话题被删了自动重建，被关了自动重开。
- 相册保持相册，不拆成一张张。

**消息不串**
- 回复关系全部记在自己的映射表里，不依赖对方的转发隐私设置。
- 消息按顺序逐条处理。

**同步**
- 对方改了消息，这边跟着改，并留下原文。你改了消息，对方那边也跟着改。
- 表态双向同步。

**防骚扰**
- 第一次发消息要答题。点到旧题、超时都不算错；连错 3 次才锁 1 小时。
- 可以按关键词、新联系人发链接、转发内容拦截，也可以让新联系人先审核。
- 单人刷屏自动暂停 10 分钟。陌生人突然大量涌入时自动进入防护，已验证的联系人不受影响。

**安全**
- 不开任何端口，机器人只往外连 Telegram，容器也不给多余权限。
- 只有主人能改设置、群发、导出。其他群里的消息一律不碰。
- 不收集 IP 和设备信息。机器人只看得到 Telegram 给的名字和用户名。

## 做不到的

- **对方删除消息同步不了**：Telegram 不把这个事件告诉普通机器人。
- **撤回有时限**：Telegram 只允许删 48 小时内的消息。
- **群里转发有限速**：Telegram 限制同一个群约每分钟 20 条。消息高峰时会排队补发，有延迟但不丢。量大的话用私聊模式。
- **私聊话题是实验功能**：不用建群也有话题，但这个开关是机器人全局的，普通用户的聊天界面也可能变化。

## 数据和隐私

你部署的机器人，数据就在你自己的服务器里，没有中心服务。聊天内容默认保留 180 天后自动抹掉（`/settings` → 数据 里可改），联系人和回复关系保留，老消息依然能回复。

如果你公开使用这个机器人，你就是这些数据的控制者，请按当地法律告知用户。

## 费用

只有服务器本身的费用。机器人很省资源，最便宜的 VPS 就够：实测刚启动、还没有聊天数据时，一个机器人的容器占约 100 MB 内存；Docker 本身的占用另算。

## 开发

```bash
npm ci
npm run check    # 类型检查
npm test         # 业务场景测试（真 SQLite + 假 Telegram）
npm run e2e      # 真实进程对假 Telegram 跑一遍
```

结构和约定见 [AGENTS.md](AGENTS.md)，同类调研见 [docs/research](docs/research/2026-11-06-tg-relay-bots.md)。

## 致谢

思路来自 [17sho/telegram-support-relay-bot](https://github.com/17sho/telegram-support-relay-bot)（MIT）。话题自愈、媒体组聚合等做法参考了 [jikssha/telegram_private_chatbot](https://github.com/jikssha/telegram_private_chatbot)、[MiHaKun/Telegram-interactive-bot](https://github.com/MiHaKun/Telegram-interactive-bot) 等项目的思路，代码是重写的。

MIT 许可。
