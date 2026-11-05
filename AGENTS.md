# 项目地图

## 项目是什么
传声筒：中文 Telegram 双向客服机器人，个人或小团队自部署。贴一个 Token、点一下链接就能用，主推部署到自己的服务器（也支持 Cloudflare Workers，同一套代码），消息不丢、不串、能自愈。

## 技术栈与目录
TypeScript，运行时零依赖（`@grammyjs/types` 只用类型）。Node 直接跑 `.ts`，不需要构建。
- `src/core/` — 业务代码，只依赖 `App` 接口，不知道自己跑在哪
- `src/runtime/worker.ts` — Workers + D1 + Webhook 入口
- `src/runtime/node.ts` — Node + node:sqlite + 长轮询入口和命令行
- `src/web/setup-page.ts` — Worker 版设置页
- `deploy/` — 安装脚本、`tgbot` 管理命令、Cloudflare 脚本
- `test/relay.test.ts` — 业务场景测试；`test/e2e/` — 真实运行环境测试
- 模块职责和依赖方向见 `docs/specs/2026-11-06-v1.md`

## 常用命令
- 类型检查：`npm run check`
- 业务测试：`npm test`
- 端到端（起真实 Worker 和 Node）：`npm run e2e`
- 看设置页：`node test/e2e/preview.ts`，打开 http://localhost:18790，Token 填 `123456:PREVIEW`
- Docker 和安装脚本：只在 CI 跑（`test/e2e/docker-smoke.ts`，需要 root 和 Docker）

## 约定
- 这是公开仓库（`backup` 远程指向它）。提交前确认没有密钥和私人信息；本仓库 `git config user.email` 是 noreply 地址，不要改回全局邮箱。
- SQL 只用 D1 和 SQLite 都支持的写法；改表结构只往 `schema.ts` 追加迁移。时间一律存 Unix 秒。
- Worker 免费版每次调用限 50 个子请求，D1 查询和 Telegram 调用都算。能合并的写入走 `db.batch`；`test/relay.test.ts` 的「免费额度」测试守这条线。
- `handleUpdate` 不能向外抛异常，Webhook 也不能返回错误状态：串行投递下会堵死后面所有更新。送不到的消息标 `failed` 由定时任务补发。
- 日志和错误信息不能带 Token。`telegram.ts` 的错误里不放 URL。
- 用户侧和管理员侧文字都用中文，写具体动作和原因，不写「操作失败」这种话。
- 给 `node.ts` 用的代码只能用可擦除的 TS 语法（`erasableSyntaxOnly`），不能用 enum 和参数属性。

## 进度与决定
- 当前进度见 PROGRESS.md，历史决定见 DECISIONS.md。
