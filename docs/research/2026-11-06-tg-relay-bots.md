# Telegram 双向客服机器人同类调研（2026-11-06）

数据取于 2026-11-06。样本偏小（单个 issue 最多 18 条评论），只能看方向。多数项目读了 README 和部分源码，都没有运行。

## 对照表

| 项目（star / 最近推送 / 许可证） | 上手 | 功能 | 最常被骂 |
|---|---|---|---|
| [17sho/telegram-support-relay-bot](https://github.com/17sho/telegram-support-relay-bot)（8 / 2026-08 / MIT） | 命令行或网页手动十几步 | 单管理员、私聊卡片、验证、屏蔽、记录 | 无 issue，问题见下节 |
| [LloydAsp/nfd](https://github.com/LloydAsp/nfd)（920 / 2025-03 / GPL-3） | 粘贴代码 | 无话题，拉黑，反诈库 | issue 已关闭，无数据 |
| [jikssha/telegram_private_chatbot](https://github.com/jikssha/telegram_private_chatbot)（609 / 2026-01 / MIT） | 有 Deploy 按钮，但仍手动绑 KV、设 webhook | 话题，题库验证，封禁，媒体组 | 验证被破解 |
| [moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1)（355 / 2026-07 / 无） | 网页粘贴 + 建 D1 | 话题，问答验证，Bot 内菜单，自动回复，编辑通知 | 创建话题失败 |
| [ohld/telegram-support-bot](https://github.com/ohld/telegram-support-bot)（404 / 2024-09 / MIT） | Heroku 按钮 | 基础转发 | 回复发不到用户 |
| [MiHaKun/Telegram-interactive-bot](https://github.com/MiHaKun/Telegram-interactive-bot)（370 / 2026-02 / Apache-2.0） | 服务器或 Docker | 话题，多客服，封禁，媒体组 | 无编辑、撤回同步 |
| [xtgm/TG-WEB-DL-bot](https://github.com/xtgm/TG-WEB-DL-bot)（0 / 2026-10 / 无） | 配置项多 | Web 面板、统计、群发、广告拦截、Turnstile | 无 issue |
| [yshalsager/telegram-feedback-bot](https://github.com/yshalsager/telegram-feedback-bot)（43 / 2026-11 / GPL-3） | Docker，Django + Postgres | 群话题或私聊话题，编辑、表态同步，Mini App | 无 |
| [Rude56/telegram-topic-bot](https://github.com/Rude56/telegram-topic-bot)（3 / 2026-10 / AGPL） | 网页粘贴 | 三种验证，编辑、表态同步，`/del` | 验证不弹出 |
| [rbqvq/Topicgram](https://github.com/rbqvq/Topicgram)（13 / 2026-10 / AGPL） | 托管版或 install.sh | 话题 | 广告骚扰 |
| [Chatwoot](https://github.com/chatwoot/chatwoot)（38929 / 2026-11） | 全套客服系统，要自己运维 | Telegram 收件箱 | 已解决会话被重开 |

**不要用：** [safiesty/TGbot-D1](https://github.com/safiesty/TGbot-D1) 复制自 moistrr，README 诱导下载 `richesse/*.zip` 并双击运行，推断是投毒。[snll66/TGbot-D1-Private](https://github.com/snll66/TGbot-D1-Private) 采集设备指纹和 WebRTC IP，有隐私风险。

## 原项目实际问题（读代码核实）

| 问题 | 位置 | 后果 |
|---|---|---|
| Webhook 不校验来源，`setWebhook` 没传 `secret_token` | `cloudflare-worker/src/index.ts:44-47` | 知道 Worker 地址就能伪造管理员回调，比如 `cleanup_confirm:all` 清空全部记录 |
| README 写 `/setup`，代码是 `/setup-webhook` | `README.md:324`、`index.ts:41` | 照文档部署得到 404 |
| README 说可填多个管理员，代码要求恰好一个 | `README.md:149`、`bot.py:29` | 照文档填两个，启动直接报错 |
| 每条消息都把建表和 ALTER 跑一遍，还要逐条清理旧卡片按钮（最多 20 次） | `index.ts:49-50,254` | 单条消息约 45 次子请求（估算），贴近免费版每次 50 的上限 |
| 处理异常返回 500，又没有按 `update_id` 去重 | `index.ts:55` | Telegram 重发，消息重复 |
| 验证通过前发的消息直接丢弃 | `bot.py:996-1000` | 用户要重发，同类也被骂过 |
| 点旧题或超时都算失败，两次锁 6 小时 | `bot.py:1175-1190` | 误伤真人 |
| 文字用 `send_message` 重发，丢掉粗体、链接等格式 | `bot.py:1070` | 格式丢失 |
| 媒体组逐条转发、无编辑同步、无话题模式 | 全部 | 多图拆散，改消息对方看不到 |
| Python 和 Worker 两份实现分别维护 | 仓库结构 | 已经出现不一致（如 `/help` 内容、验证文案） |
| 界面其实已是中文 | | 「全中文」的主要缺口是类型名（`photo`）和文档细节 |

## 高频抱怨 Top 5

1. **部署失败、报错看不懂**：[D1#4](https://github.com/moistrr/TGbot-D1/issues/4)（18 条评论）、[D1#2](https://github.com/moistrr/TGbot-D1/issues/2)、[jikssha#5](https://github.com/jikssha/telegram_private_chatbot/issues/5)、[D1#8](https://github.com/moistrr/TGbot-D1/issues/8)（匿名管理员）
2. **验证被破解、广告**：[jikssha#13](https://github.com/jikssha/telegram_private_chatbot/issues/13)（15 条）、[#15](https://github.com/jikssha/telegram_private_chatbot/issues/15)、[Topicgram#1](https://github.com/rbqvq/Topicgram/issues/1)
3. **回复发不到用户**（靠 `forward_from` 映射，被隐私设置挡）：[ohld#5](https://github.com/ohld/telegram-support-bot/issues/5)、[#1](https://github.com/ohld/telegram-support-bot/issues/1)
4. **话题删除后失联或重复建话题**：[jikssha#3](https://github.com/jikssha/telegram_private_chatbot/issues/3)、[D1#12](https://github.com/moistrr/TGbot-D1/issues/12)
5. **同步与丢消息**：[媒体组被拆开](https://github.com/ohld/telegram-support-bot/issues/24)、[编辑撤回](https://github.com/MiHaKun/Telegram-interactive-bot/issues/9)、[验证后首条丢失](https://github.com/MiHaKun/Telegram-interactive-bot/issues/10)

## Telegram 官方能力（core.telegram.org，Bot API 10.3）

- 私聊话题：9.3 加 `has_topics_enabled`，`createForumTopic` 可用于私聊。需在 BotFather 打开，是 bot 级设置，普通用户界面也可能受影响，必须真机验证。
- 普通 bot 收不到用户删除消息的事件，只有 `edited_message`。
- `copyMessages` 文档写明 “Album grouping is kept”，`copyMessage` 没有这句。
- `setMessageReaction` 每条 1 个表态；`message_reaction` 需写入 `allowed_updates`。
- 限流（FAQ）：单聊约 1 条/秒，群 20 条/分钟，群发约 30 条/秒。

## 借什么

- 话题自愈、建话题抢占锁、媒体组延迟聚合：思路来自 jikssha（MIT）、MiHaKun（Apache-2.0）、moistrr，自己实现。
- `/del` 双删、编辑同步：思路来自 Rude56（AGPL），只借思路。
- 过滤后隔离不丢、`my_chat_member` 感知拉黑：思路来自 xtgm（无许可证），只借思路。
- 验证按钮随机令牌、答案不进回调数据：原项目（MIT）。
- Deploy 按钮 + 自动建 D1：Cloudflare 官方能力。

## 避什么

- 不靠 `forward_from` 映射，全部走自己的消息映射表。
- 处理异常不返回 500，不让一条坏消息堵死后续更新。
- 过滤不直接丢，进隔离区可放行。
- 不采集指纹、IP。

## 我们凭什么

**贴一个 Token、点一下链接就能用，两种部署同一套代码，消息不丢、不串、能自愈。**

1. **真一键部署**：Deploy 按钮或服务器一条命令；不用查数字 ID，点认领链接就成为管理员；Webhook 自动注册带密钥。
2. **可靠投递**：映射表、话题自愈、媒体组 `copyMessages`、限流重试、失败补发、验证前消息不丢。
3. **不建群也能用**：默认私聊卡片模式零配置，要多人协作再绑话题群，私聊话题作为实验选项。

## 不做什么

- Web 管理面板：多一个登录面和攻击面，配置都放 Telegram 里。以后有多人需求再说。
- 设备指纹、WebRTC IP、Turnstile 网页验证：隐私代价大，同类已有人因此有风险。
- 多机器人托管（Livegram 式）：定位是每人自部署一个。
- 全套工单系统：要工单的人去用 Chatwoot。
- 数字人 AI 自动回复：先把中继做稳，放进以后再说。
