# 项目地图

## 项目是什么
传声筒：中文 Telegram 私人双向机器人，个人或小团队自部署，没有中心服务。一个进程跑多个机器人，每个一份目录、Token 文件和数据库，数据互不相通。网页管理只给部署的人用，看不到聊天内容。贴一个 Token、在机器人里点一下按钮就能部署到自己的服务器，消息不丢、不串、能自愈。

## 技术栈与目录
TypeScript + Node 自带的 SQLite，运行时零依赖（`@grammyjs/types` 只用类型）。开发和测试时 Node 直接跑 `.ts`；Docker 镜像构建时用 `src/build.ts` 预先转成 `dist/`，省内存。
- `src/core/` — 业务代码，只依赖 `App` 接口
- `src/runtime/node.ts` — 程序入口：命令行，按磁盘上的 Token 文件启停机器人
- `src/runtime/runner.ts` — 跑一个机器人（长轮询、定时任务）
- `src/runtime/fleet.ts` — 多机器人的增删查，命令行和网页共用
- `src/runtime/web.ts`、`web-page.ts`、`tls.ts` — 网页管理（接口、页面、自签证书）
- `src/runtime/sqlite-adapter.ts` — 数据库适配
- `deploy/` — 安装脚本、`tgbot` 管理命令（默认机器人的数据在 `/data/relay.db`，新增的在 `/data/bots/名字/`）
- `test/relay.test.ts` — 业务场景测试；`test/e2e/` — 真实进程和安装流程测试
- 模块职责和依赖方向见 `docs/specs/2026-11-06-v1.md`

## 常用命令
- 类型检查：`npm run check`
- 业务测试：`npm test`
- 端到端（起真实 Node 进程）：`npm run e2e`
- 本机跑：`node --env-file=.env src/runtime/node.ts`
- Docker 和安装脚本：只在 CI 跑（`test/e2e/docker-smoke.ts`，需要 root 和 Docker）

## 约定
- 这是公开仓库（`backup` 远程指向它）。提交前确认没有密钥和私人信息；本仓库 `git config user.email` 是 noreply 地址，不要改回全局邮箱。
- 改表结构只往 `schema.ts` 追加迁移。时间一律存 Unix 秒。
- `handleUpdate` 不能向外抛异常，一条坏更新不能影响后面的消息。送不到的消息标 `failed` 由定时任务补发。
- 日志和错误信息不能带 Token。`telegram.ts` 的错误里不放 URL。
- 用户侧和管理员侧文字都用中文，写具体动作和原因，不写「操作失败」这种话。
- 管理员不一定会打命令：新的管理功能要能从 `/menu` 面板点按钮完成（`menus.ts` 画页面，`panel.ts` 处理按钮和分步输入），命令只是给习惯打字的人的另一条路。
- 只能用可擦除的 TS 语法（`erasableSyntaxOnly`），不能用 enum 和参数属性：Node 直接跑源码。

## 进度与决定
- 当前进度见 PROGRESS.md，历史决定见 DECISIONS.md。
