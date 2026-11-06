// 程序入口：长轮询，一个进程跑一台服务器上的所有机器人。
//   node src/runtime/node.ts                    运行
//   node src/runtime/node.ts claim [名字]        重新生成绑定方式
//   node src/runtime/node.ts backup 目标 [名字]   在线备份数据库
//   node src/runtime/node.ts add [名字]          从标准输入读 Token，新增机器人
//   node src/runtime/node.ts remove 名字         删除机器人和它的数据
//   node src/runtime/node.ts token 名字          从标准输入读 Token，更换
//   node src/runtime/node.ts list               列出所有机器人
//   node src/runtime/node.ts web-auth           从标准输入读两行：账号、密码，设置网页登录
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { App } from "../core/app.ts";
import { loadSettings } from "../core/settings.ts";
import { claimLink, createClaim, fetchBot } from "../core/setup.ts";
import { createTelegram, TelegramError } from "../core/telegram.ts";
import { cryptoRng } from "../core/verify.ts";
import { addBot, allNames, dbPath, DEFAULT_NAME, describeBot, extraNames, readToken, removeBot, replaceToken } from "./fleet.ts";
import type { BotInfo, FleetEnv } from "./fleet.ts";
import { startBot } from "./runner.ts";
import type { RunningBot } from "./runner.ts";
import { sqliteDb } from "./sqlite-adapter.ts";
import { setAuth, startWeb } from "./web.ts";

const SCAN_INTERVAL_MS = 3000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
  throw new Error(message);
}

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true });
const env: FleetEnv = { dataDir, apiBase: process.env.TELEGRAM_API_BASE, defaultToken: process.env.BOT_TOKEN?.trim() };

async function printClaim(app: App, username: string): Promise<void> {
  const s = app.settings;
  const link = claimLink(username, s.claimCode);
  if (s.ownerId !== null) {
    console.log(`\n用新管理员的账号打开这个链接并点开始（10 分钟内有效）：\n${link}\n`);
    return;
  }
  if (s.claimExpiresAt <= app.now()) {
    console.log("\n绑定已过期。运行 tgbot claim 重新生成。\n");
    return;
  }
  const pair = s.claimPair ? `再点和这个一样的图案：\n配对图案：${s.claimPair}\n` : "配对按钮已失效，用下面的链接。\n";
  console.log(`\n用要当管理员的账号打开 @${username}，点开始，${pair}也可以直接打开这个链接，不用点图案：\n${link}\n`);
}

function readStdin(): Promise<string[]> {
  return new Promise((done) => {
    let text = "";
    process.stdin.on("data", (chunk: Buffer) => (text += chunk.toString()));
    process.stdin.on("end", () => done(text.split("\n").map((line) => line.trim())));
  });
}

const readStdinLine = async () => (await readStdin())[0] ?? "";

function infoLine(info: BotInfo): string {
  const state = info.bound ? `已绑定 ${info.ownerName || ""}`.trim() : info.claimOpen ? (info.claimMode === "user" ? `等 @${info.claimUser} 绑定` : info.claimMode === "pair" ? `等人绑定，配对图案 ${info.claimPair || "已失效"}` : info.claimMode === "link" ? "等人用链接绑定" : "等人绑定") : "绑定已过期";
  return [info.name, info.username ? `@${info.username}` : "-", state].join("\t");
}

async function cliClaim(name: string): Promise<void> {
  if (!allNames(env).includes(name)) fail(`没有叫 ${name} 的机器人。`);
  const db = sqliteDb(dbPath(env, name));
  const app: App = {
    db,
    tg: createTelegram({ token: readToken(env, name), apiBase: env.apiBase }),
    settings: await loadSettings(db),
    rng: cryptoRng,
    now: () => Math.floor(Date.now() / 1000),
    nowMs: () => Date.now(),
    defer: () => undefined,
    log: () => undefined,
  };
  const bot = await fetchBot(app).catch(() => fail("Telegram 不认这个 Token，或连不上 Telegram。"));
  await createClaim(app);
  await printClaim(app, bot.username);
  db.close();
}

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

if (command !== undefined) {
  try {
    switch (command) {
      case "claim":
        await cliClaim(arg1 ?? DEFAULT_NAME);
        break;
      case "backup": {
        if (!arg1) fail("用法：backup 目标文件路径 [名字]");
        const db = sqliteDb(dbPath(env, arg2 ?? DEFAULT_NAME));
        db.vacuumInto(resolve(arg1));
        console.log(`已备份到 ${resolve(arg1)}`);
        db.close();
        break;
      }
      case "add": {
        const info = await addBot(env, await readStdinLine(), { name: arg1, claimUser: arg2 });
        console.log(infoLine(info));
        break;
      }
      case "remove":
        removeBot(env, arg1 ?? "");
        console.log(`已删除 ${arg1}`);
        break;
      case "token":
        await replaceToken(env, arg1 ?? "", await readStdinLine());
        console.log("已更换，几秒后生效。");
        break;
      case "token-check": {
        const token = await readStdinLine();
        if (allNames(env).some((name) => name !== DEFAULT_NAME && readToken(env, name) === token)) {
          console.log("used");
          break;
        }
        const result = await createTelegram({ token, apiBase: env.apiBase }).call("getMe").then(
          () => "ok",
          (error: unknown) => (error instanceof TelegramError && error.code === 401 ? "invalid" : "unreachable"),
        );
        console.log(result);
        break;
      }
      case "web-auth": {
        const [user = "", password = ""] = await readStdin();
        setAuth(env, user, password);
        console.log("网页登录已设置。");
        break;
      }
      case "list":
        for (const name of allNames(env)) console.log(infoLine(await describeBot(env, name)));
        break;
      default:
        fail(`不认识的命令：${command}。可用：claim、backup、add、remove、token、list`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  process.exit(0);
}

const webPort = Number(process.env.WEB_LISTEN_PORT ?? process.env.WEB_PORT ?? 0);
// 开了网页就可以先不配机器人，部署好再到网页上加
if (!env.defaultToken && extraNames(env).length === 0 && !webPort) {
  fail("没有配置 BOT_TOKEN。到 @BotFather 拿到 Token，写进 .env 后再启动。");
}

const running = new Map<string, RunningBot>();
let stopping = false;

const broken = new Map<string, string>();

function launch(name: string, token: string): void {
  const isDefault = name === DEFAULT_NAME;
  // 一个机器人的数据库坏了，只有它起不来，不能连累别的
  if (broken.get(name) === token) return;
  try {
    running.set(name, startOne(name, token, isDefault));
    broken.delete(name);
  } catch (error) {
    broken.set(name, token);
    console.error(`机器人 ${name} 启动失败：`, error instanceof Error ? error.message : String(error));
    if (isDefault && extraNames(env).length === 0 && !webPort) process.exit(1);
  }
}

function startOne(name: string, token: string, isDefault: boolean): RunningBot {
  return startBot({
      label: isDefault ? "" : name,
      token,
      dbFile: dbPath(env, name),
      apiBase: env.apiBase,
      async onConnected(app, username) {
        if (app.settings.ownerId !== null) return;
        // 只有从没生成过才生成。重启不能换绑定方式，也不能把过期的绑定重新打开：
        // 指定了用户名的机器人过期后要是自动变成谁先点算谁，就等于谁都能抢
        if (!app.settings.claimCode && app.settings.claimExpiresAt === 0) await createClaim(app, isDefault ? undefined : { mode: "open" });
        if (isDefault) await printClaim(app, username);
      },
      onFatal(message) {
        console.error(message);
        // 只有默认一个机器人时直接退出，和以前一样让人一眼看到；有别的机器人时不能连累它们
        if (isDefault && extraNames(env).length === 0 && !webPort) process.exit(1);
      },
  });
}

/** 对照磁盘上的 Token 文件启停机器人，新增删除都不用重启进程。 */
function scan(): void {
  const wanted = new Map(allNames(env).map((name) => [name, readToken(env, name)]));
  for (const [name, bot] of running) {
    if (wanted.get(name) === bot.token) continue;
    running.delete(name);
    console.log(`停止机器人 ${name}`);
    void bot.stop();
  }
  for (const [name, token] of wanted) {
    if (!running.has(name)) launch(name, token);
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("正在停止…");
  clearInterval(scanner);
  await Promise.allSettled([...running.values()].map((bot) => bot.stop()));
  console.log("已停止。");
  process.exit(0);
}
// 进程里跑着所有人的机器人。意料之外的错误记下来，不让一处问题把大家都带下线
process.on("uncaughtException", (error) => console.error("未捕获的错误：", error.message));
process.on("unhandledRejection", (error) => console.error("未处理的错误：", error instanceof Error ? error.message : String(error)));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

scan();
if (webPort) {
  startWeb({ env, port: webPort, stateOf: (name) => running.get(name)?.state() ?? (broken.has(name) ? "failed" : "stopped") });
}
console.log("传声筒已启动");
const scanner = setInterval(() => {
  if (existsSync(dataDir)) scan();
}, SCAN_INTERVAL_MS);
