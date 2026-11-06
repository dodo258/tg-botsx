// 故障演练：程序被强杀、Telegram 报错和限流时，消息会不会丢、会不会重复。跑的是镜像里那份转好的 JS。
// 假 Telegram 按真实规则重发：只有下一次 getUpdates 带上 offset，之前的更新才算确认。
// 运行：node test/e2e/chaos.ts [长跑分钟数]
import { execSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TOKEN = "100000:CHAOS_TOKEN_for_test";
const OWNER = 1000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const out = mkdtempSync(join(tmpdir(), "chaos-dist-"));
execSync(`node --disable-warning=ExperimentalWarning src/build.ts ${out}`, { stdio: "ignore" });

type Mode = "ok" | "500" | "429" | "hang";
let mode: Mode = "ok";
let nextUpdate = 1;
let confirmed = 0;
let nextMsg = 9000;
const pending: { update_id: number }[] = [];
const copies = new Map<number, number>();
const scheduled = new Map<number, number>();

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const method = /^\/bot[^/]+\/(\w+)/.exec(req.url ?? "")?.[1] ?? "";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // 上传是 multipart
    }
    if (method === "getMe") return send(200, { ok: true, result: { id: 42, is_bot: true, first_name: "t", username: "chaos_bot" } });
    if (method === "getUpdates") {
      const offset = Number(body.offset ?? 0);
      if (offset > confirmed) confirmed = offset;
      if (mode === "500") return setTimeout(() => send(502, { ok: false, error_code: 502, description: "Bad Gateway" }), 100);
      const batch = pending.filter((update) => update.update_id >= confirmed).slice(0, 100);
      return setTimeout(() => send(200, { ok: true, result: batch }), batch.length ? 0 : 100);
    }
    if (mode === "hang" && method === "copyMessage") return; // 不回应，等客户端超时
    if (mode === "500") return send(502, { ok: false, error_code: 502, description: "Bad Gateway" });
    if (mode === "429" && method === "copyMessage") return send(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } });
    if (method === "sendMessage" && body.text === "定时内容") scheduled.set(Number(body.chat_id), (scheduled.get(Number(body.chat_id)) ?? 0) + 1);
    if (method === "copyMessage" && body.chat_id === OWNER) copies.set(Number(body.message_id), (copies.get(Number(body.message_id)) ?? 0) + 1);
    if (["copyMessage", "sendMessage", "forwardMessage", "sendDocument"].includes(method)) return send(200, { ok: true, result: { message_id: nextMsg++ } });
    return send(200, { ok: true, result: true });
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("没有端口");
const apiBase = `http://127.0.0.1:${address.port}`;

const dataDir = mkdtempSync(join(tmpdir(), "chaos-data-"));
const env = { ...process.env, BOT_TOKEN: TOKEN, DATA_DIR: dataDir, TELEGRAM_API_BASE: apiBase };
function start(): ChildProcess {
  return spawn("node", ["--max-semi-space-size=1", "--disable-warning=ExperimentalWarning", join(out, "runtime/node.js")], { env, stdio: "ignore" });
}

let nextId = 1;
const sentIds: number[] = [];
function say(count: number): void {
  for (let index = 0; index < count; index++) {
    const id = nextId++;
    const user = 7000 + (id % 20);
    sentIds.push(id);
    pending.push({ update_id: nextUpdate++, message: { message_id: id, date: 1, chat: { id: user, type: "private" }, from: { id: user, is_bot: false, first_name: `u${user}` }, text: `消息 ${id}` } } as { update_id: number });
  }
}
// 重复：发出去和写库之间被强杀时，重启后会再发一次。Telegram 没有防重发的接口，这个窗口消不掉，
// 只能二选一，这里选宁可多收一条也不丢。所以丢失必须是 0，重复不能超过强杀次数
let kills = 0;
function report(name: string): boolean {
  const lost = sentIds.filter((id) => !copies.has(id));
  const dup = [...copies.values()].filter((count) => count > 1).length;
  const pass = lost.length === 0 && dup <= kills;
  console.log(`${pass ? "通过" : "失败"}  ${name}：发 ${sentIds.length} 条，丢 ${lost.length}，重复 ${dup}${lost.length ? `，丢的 ${lost.slice(0, 8).join(",")}` : ""}`);
  return pass;
}
async function drain(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (sentIds.every((id) => copies.has(id))) return;
    await sleep(250);
  }
}

let failed = 0;
let bot = start();
await sleep(3000);
const db = new DatabaseSync(join(dataDir, "relay.db"));
for (const [key, value] of [["ownerId", String(OWNER)], ["verifyMode", '"off"'], ["messagesPerMinute", "100000"], ["floodThreshold", "100000"]] as const) {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
db.close();

say(200);
await drain(20_000);
if (!report("正常收发")) failed++;

// 处理途中强杀，反复三次
for (let round = 1; round <= 3; round++) {
  say(300);
  await sleep(60);
  bot.kill("SIGKILL");
  kills++;
  await sleep(300);
  bot = start();
  await drain(45_000);
  if (!report(`处理途中强杀第 ${round} 次`)) failed++;
}

// 优雅停止
say(300);
await sleep(60);
bot.kill("SIGTERM");
await sleep(2500);
if (bot.exitCode === null) console.log("提醒：SIGTERM 后 2.5 秒还没退出");
bot.kill("SIGKILL");
kills++;
bot = start();
await drain(45_000);
if (!report("处理途中优雅停止")) failed++;

// Telegram 接口全挂 15 秒
mode = "500";
say(50);
await sleep(15_000);
mode = "ok";
await drain(90_000);
if (!report("Telegram 报错 15 秒后恢复")) failed++;

// 被限流
mode = "429";
say(50);
await sleep(6000);
mode = "ok";
await drain(90_000);
if (!report("被限流后恢复")) failed++;

// 定时发送途中被强杀：每个联系人都要收到，最多多收一次，不能从头再发一遍
{
  const scheduleDb = new DatabaseSync(join(dataDir, "relay.db"));
  scheduleDb.prepare("INSERT INTO schedules(text, repeat_kind, times, run_at, enabled, created_at) VALUES('定时内容', 'daily', '00:00', ?, 1, 1)").run(Math.floor(Date.now() / 1000));
  scheduleDb.close();
  const until = Date.now() + 40_000;
  while (scheduled.size === 0 && Date.now() < until) await sleep(5);
  bot.kill("SIGKILL");
  kills++;
  await sleep(300);
  bot = start();
  const end = Date.now() + 70_000;
  while (scheduled.size < 20 && Date.now() < end) await sleep(500);
  await sleep(25_000);
  const most = Math.max(0, ...scheduled.values());
  const pass = scheduled.size === 20 && most <= 2 && [...scheduled.values()].filter((count) => count > 1).length <= 1;
  console.log(`${pass ? "通过" : "失败"}  定时发送途中强杀：${scheduled.size}/20 人收到，最多收到 ${most} 次`);
  if (!pass) failed++;
}

// 长跑：看内存涨不涨
const minutes = Number(process.argv[2] ?? 0);
if (minutes > 0) {
  const rss = () => Math.round(Number(execSync(`ps -o rss= -p ${bot.pid}`, { encoding: "utf8" })) / 1024);
  const samples: number[] = [];
  const end = Date.now() + minutes * 60_000;
  let tick = 0;
  while (Date.now() < end) {
    say(10);
    await sleep(1000);
    if (++tick % 60 === 0) samples.push(rss());
  }
  await drain(60_000);
  console.log(`内存（每分钟，MB）：${samples.join(" ")}`);
  if (!report(`长跑 ${minutes} 分钟，每秒 10 条`)) failed++;
}

console.log(`进程还活着：${bot.exitCode === null}`);
bot.kill("SIGKILL");
server.closeAllConnections();
server.close();
rmSync(out, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
