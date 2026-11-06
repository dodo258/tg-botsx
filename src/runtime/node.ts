// 程序入口：长轮询，不需要公网地址和域名。
//   node src/runtime/node.ts          运行
//   node src/runtime/node.ts claim    生成认领链接
//   node src/runtime/node.ts backup 目标文件   在线备份数据库
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Update } from "@grammyjs/types";
import type { App } from "../core/app.ts";
import { tick } from "../core/maintenance.ts";
import { handleUpdate, isUpdate } from "../core/router.ts";
import { migrate } from "../core/schema.ts";
import { loadSettings } from "../core/settings.ts";
import { ALLOWED_UPDATES, claimLink, createClaim, fetchBot, syncCommands } from "../core/setup.ts";
import { createTelegram, TelegramError } from "../core/telegram.ts";
import { cryptoRng } from "../core/verify.ts";
import { sqliteDb } from "./sqlite-adapter.ts";

const POLL_TIMEOUT_SECONDS = 30;
const TICK_INTERVAL_MS = 20_000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
  throw new Error(message);
}

const token = process.env.BOT_TOKEN?.trim();
if (!token) fail("没有配置 BOT_TOKEN。到 @BotFather 拿到 Token，写进 .env 后再启动。");

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true });
const dbFile = join(dataDir, "relay.db");
const db = sqliteDb(dbFile);
await migrate(db);

const apiBase = process.env.TELEGRAM_API_BASE;
const tg = createTelegram({ token, apiBase, maxRetryAfter: 30 });
const pollClient = createTelegram({ token, apiBase, timeoutMs: (POLL_TIMEOUT_SECONDS + 15) * 1000 });

const pending = new Set<Promise<void>>();

async function buildApp(): Promise<App> {
  return {
    db,
    tg,
    settings: await loadSettings(db),
    rng: cryptoRng,
    now: () => Math.floor(Date.now() / 1000),
    nowMs: () => Date.now(),
    defer(task, delayMs) {
      const job = new Promise<void>((done) => setTimeout(done, delayMs))
        .then(task)
        .catch((error: unknown) => {
          console.error("后台任务失败：", error instanceof Error ? error.message : String(error));
        })
        .finally(() => pending.delete(job));
      pending.add(job);
    },
    log(level, message, detail) {
      const line = `${new Date().toISOString()} ${level === "error" ? "错误" : level === "warn" ? "警告" : "信息"} ${message}${detail === undefined ? "" : `：${String(detail)}`}`;
      if (level === "error") console.error(line);
      else console.log(line);
    },
  };
}

async function printClaim(app: App, username: string): Promise<void> {
  const code = await createClaim(app);
  if (app.settings.ownerId === null) {
    console.log(`\n用要当管理员的账号打开 @${username}，点开始，再点和这个一样的图案（10 分钟内有效）：\n配对图案：${app.settings.claimPair}\n也可以直接打开这个链接，不用点图案：\n${claimLink(username, code)}\n`);
  } else {
    console.log(`\n用新管理员的账号打开这个链接并点开始（10 分钟内有效）：\n${claimLink(username, code)}\n`);
  }
}

const command = process.argv[2];

if (command === "claim") {
  const app = await buildApp();
  const bot = await fetchBot(app).catch(() => fail("Telegram 不认这个 Token，或连不上 Telegram。"));
  await printClaim(app, bot.username);
  db.close();
  process.exit(0);
}

if (command === "backup") {
  const target = process.argv[3];
  if (!target) fail("用法：backup 目标文件路径");
  db.vacuumInto(resolve(target));
  console.log(`已备份到 ${resolve(target)}`);
  db.close();
  process.exit(0);
}

if (command !== undefined) fail(`不认识的命令：${command}。可用：claim、backup`);

let stopping = false;
let handling = false;
let timer: ReturnType<typeof setInterval> | undefined;

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await Promise.allSettled([...pending]);
  db.close();
  console.log("已停止。");
  process.exit(0);
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  console.log("正在停止…");
  // 正在等长轮询时可以直接退出：没确认的更新下次还会收到，也有去重兜底
  if (!handling) void shutdown();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const startup = await buildApp();
let bot: { username: string };
try {
  // 这个 Token 以前被别的程序设过 Webhook 的话要先删，否则长轮询会报 409
  await tg.call("deleteWebhook", { drop_pending_updates: false });
  bot = await fetchBot(startup);
  await syncCommands(startup);
} catch (error) {
  if (error instanceof TelegramError && error.code === 401) fail("Telegram 不认这个 Token（401）。到 @BotFather 核对后改 .env。");
  fail(`启动失败，连不上 Telegram：${error instanceof Error ? error.message : String(error)}\n服务器在国内的话需要代理，见 README。`);
}
console.log(`已连接 @${bot.username}，数据在 ${dbFile}`);
if (startup.settings.ownerId === null) await printClaim(startup, bot.username);

let ticking = false;
timer = setInterval(() => {
  if (ticking) return;
  ticking = true;
  buildApp()
    .then((app) => tick(app))
    .catch((error: unknown) => {
      console.error("定时任务失败：", error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      ticking = false;
    });
}, TICK_INTERVAL_MS);

let offset = 0;
let backoff = 1000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

while (!stopping) {
  try {
    const updates = await pollClient.call<unknown[]>("getUpdates", { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ALLOWED_UPDATES });
    backoff = 1000;
    for (const raw of updates) {
      if (!isUpdate(raw)) continue;
      const update: Update = raw;
      offset = update.update_id + 1;
      handling = true;
      await handleUpdate(await buildApp(), update);
      handling = false;
    }
  } catch (error) {
    if (stopping) break;
    if (error instanceof TelegramError && error.code === 409) {
      console.error("另一个程序正在用这个 Token 收消息。同一个 Token 只能跑一份，请停掉另一份。10 秒后重试。");
      await sleep(10_000);
      continue;
    }
    if (error instanceof TelegramError && error.code === 401) fail("Token 已失效（401）。到 @BotFather 拿新的，改 .env 后重启。");
    console.error(`收消息失败，${backoff / 1000} 秒后重试：`, error instanceof Error ? error.message : String(error));
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

await shutdown();
