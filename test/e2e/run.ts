// 端到端：起真实的 Worker（wrangler dev + 本地 D1）和真实的 Node 进程，对着假 Telegram 跑一遍。
// 运行：npm run e2e
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTelegram } from "./fake-telegram.ts";
import type { FakeServer } from "./fake-telegram.ts";

const TOKEN = "123456:TEST_TOKEN_for_e2e";
const OWNER = 1000;
const ALICE = 2001;
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "通过" : "失败"}  ${name}${ok || detail === undefined ? "" : `\n      实际：${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, test: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await test()) return true;
    await sleep(100);
  }
  console.log(`等待超时：${what}`);
  return false;
}

function start(command: string, args: string[], env: Record<string, string>, log: string[]): ChildProcess {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  return child;
}

let updateId = 1;
function textUpdate(userId: number, text: string, messageId: number): Record<string, unknown> {
  return { update_id: updateId++, message: { message_id: messageId, date: 1, chat: { id: userId, type: "private" }, from: { id: userId, is_bot: false, first_name: `用户${userId}` }, text } };
}

function claimCodeFrom(link: unknown): string {
  return /claim_([\w-]+)/.exec(String(link))?.[1] ?? "";
}

async function testWorker(fake: FakeServer): Promise<void> {
  console.log("\n== Cloudflare Worker（wrangler dev + 本地 D1）==");
  const port = 18787;
  const persist = mkdtempSync(join(tmpdir(), "tg-botsx-d1-"));
  const log: string[] = [];
  const worker = start("npx", ["wrangler", "dev", "--port", String(port), "--persist-to", persist, "--test-scheduled", "--var", `BOT_TOKEN:${TOKEN}`, "--var", `TELEGRAM_API_BASE:${fake.url}`, "--show-interactive-dev-session=false"], { WRANGLER_SEND_METRICS: "false" }, log);
  const base = `http://127.0.0.1:${port}`;
  try {
    const up = await waitFor("Worker 启动", async () => {
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
    check("Worker 启动，/health 正常", up, log.slice(-5));
    if (!up) return;

    const page = await fetch(`${base}/`);
    const html = await page.text();
    check("设置页能打开且是中文", page.ok && html.includes("传声筒"));
    check("设置页带 CSP", (page.headers.get("content-security-policy") ?? "").includes("default-src 'none'"));

    const setup = (token: string) => fetch(`${base}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    check("Token 错误被拒绝", (await setup("wrong")).status === 403);
    check("Token 错误时没有碰 Telegram", fake.calls.length === 0, fake.calls);

    const forged = textUpdate(ALICE, "伪造", 1);
    const noSecret = await fetch(`${base}/telegram/webhook`, { method: "POST", body: JSON.stringify(forged) });
    check("没有密钥的伪造请求返回 401", noSecret.status === 401);
    const badSecret = await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "guess" }, body: JSON.stringify(forged) });
    check("密钥错误的伪造请求返回 401", badSecret.status === 401);

    const ok = await setup(TOKEN);
    const body = (await ok.json()) as { ok: boolean; claimLink: string; username: string; hasOwner: boolean };
    check("Token 正确后返回认领链接", ok.status === 200 && body.claimLink.startsWith("https://t.me/demo_bot?start=claim_"), body);
    check("Webhook 注册到正确地址", fake.webhook.url === `${base}/telegram/webhook`, fake.webhook);
    check("Webhook 带密钥且串行投递", fake.webhook.secret.length > 20 && fake.named("setWebhook")[0]?.max_connections === 1);
    check("注册了命令菜单", fake.named("setMyCommands").length >= 1);

    const hook = (update: unknown) => fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": fake.webhook.secret, "content-type": "application/json" }, body: JSON.stringify(update) });
    const status = async () => (await (await fetch(`${base}/setup/status`, { method: "POST", body: JSON.stringify({ token: TOKEN }) })).json()) as { claimed: boolean };
    check("认领前状态是未认领", (await status()).claimed === false);

    const claim = await hook(textUpdate(OWNER, `/start claim_${claimCodeFrom(body.claimLink)}`, 2));
    check("Webhook 正常请求返回 200", claim.status === 200);
    check("认领成功", (await status()).claimed === true);
    check("认领后收到中文说明", String(fake.named("sendMessage").at(-1)?.text).includes("绑定成功"));

    await hook(textUpdate(ALICE, "你好，我想咨询", 3));
    const challenge = fake.named("sendMessage").at(-1);
    check("陌生人收到验证题", challenge?.chat_id === ALICE && String(challenge?.text).includes("答一道题"), challenge);

    const markup = challenge?.reply_markup as { inline_keyboard: { callback_data: string; text: string }[][] };
    // 不知道哪个是对的就一个个试：答错最多两次不会锁（上限 3 次）。这里只验证答错的路径。
    const wrong = markup.inline_keyboard[0]?.[0]?.callback_data ?? "";
    await hook({ update_id: updateId++, callback_query: { id: "c1", from: { id: ALICE, is_bot: false, first_name: "a" }, chat_instance: "x", data: wrong, message: { message_id: 50, date: 1, chat: { id: ALICE, type: "private" } } } });
    check("按钮回调被应答", fake.named("answerCallbackQuery").length >= 1);

    // Cron：Worker 运行环境里定时任务能跑
    const cron = await fetch(`${base}/__scheduled?cron=*+*+*+*+*`);
    check("定时任务能执行", cron.ok, await cron.text());

    // 重启后数据还在，迁移不重复执行
    const dup = await hook(textUpdate(OWNER, "/status", 9));
    check("管理员命令可用", dup.status === 200 && String(fake.named("sendMessage").at(-1)?.text).includes("运行状态"), fake.named("sendMessage").at(-1));
  } finally {
    worker.kill("SIGTERM");
    await sleep(500);
    rmSync(persist, { recursive: true, force: true });
    const errors = log.join("").split("\n").filter((line) => /✘|Uncaught|exceeded/i.test(line));
    check("Worker 日志没有未捕获错误", errors.length === 0, errors.slice(0, 5));
    const leaked = log.join("").includes(TOKEN);
    check("Worker 日志没有泄露 Token", !leaked);
  }
}

async function testNode(fake: FakeServer): Promise<void> {
  console.log("\n== 服务器版（Node 长轮询）==");
  fake.calls.length = 0;
  const dataDir = mkdtempSync(join(tmpdir(), "tg-botsx-node-"));
  const env = { BOT_TOKEN: TOKEN, DATA_DIR: dataDir, TELEGRAM_API_BASE: fake.url, NODE_NO_WARNINGS: "1" };
  const log: string[] = [];
  const entry = "src/runtime/node.ts";
  const node = start("node", [entry], env, log);
  try {
    const linked = await waitFor("打印认领链接", () => log.join("").includes("start=claim_"));
    check("启动后打印认领链接", linked, log.join(""));
    check("启动时删除旧 Webhook", fake.named("deleteWebhook").length === 1);
    const code = /claim_([\w-]+)/.exec(log.join(""))?.[1] ?? "";

    fake.queue.push(textUpdate(OWNER, `/start claim_${code}`, 1));
    check("长轮询收到认领并绑定", await waitFor("绑定", () => fake.named("sendMessage").some((m) => String(m.text).includes("绑定成功"))));

    fake.queue.push(textUpdate(ALICE, "你好", 2));
    check("陌生人收到验证题", await waitFor("验证题", () => fake.named("sendMessage").some((m) => m.chat_id === ALICE && String(m.text).includes("答一道题"))));

    const before = fake.calls.length;
    node.kill("SIGTERM");
    const exited = await waitFor("进程退出", () => node.exitCode !== null, 8000);
    check("收到 SIGTERM 能正常退出", exited && node.exitCode === 0, node.exitCode);
    check("退出时没有多余调用", fake.calls.length === before);

    // 重启：数据还在，不再要求认领
    const secondLog: string[] = [];
    const second = start("node", [entry], env, secondLog);
    const connected = await waitFor("重启", () => secondLog.join("").includes("已连接"));
    check("重启后数据还在，不再打印认领链接", connected && !secondLog.join("").includes("start=claim_"), secondLog.join(""));

    const backup = join(dataDir, "backup.db");
    const backupProcess = start("node", [entry, "backup", backup], env, []);
    await waitFor("备份完成", () => backupProcess.exitCode !== null);
    check("运行中可以在线备份", backupProcess.exitCode === 0 && existsSync(backup));

    const claimProcessLog: string[] = [];
    const claimProcess = start("node", [entry, "claim"], env, claimProcessLog);
    await waitFor("生成认领链接", () => claimProcess.exitCode !== null);
    check("claim 命令能重新生成链接", claimProcess.exitCode === 0 && claimProcessLog.join("").includes("start=claim_"), claimProcessLog.join(""));

    const conflictFree = secondLog.join("");
    second.kill("SIGTERM");
    await waitFor("第二个进程退出", () => second.exitCode !== null, 8000);
    check("服务器版日志没有泄露 Token", !conflictFree.includes(TOKEN) && !log.join("").includes(TOKEN));

    const badLog: string[] = [];
    const bad = start("node", [entry], { ...env, BOT_TOKEN: "111:bad", DATA_DIR: mkdtempSync(join(tmpdir(), "tg-botsx-bad-")) }, badLog);
    await waitFor("坏 Token 退出", () => bad.exitCode !== null);
    check("Token 无效时报中文错误并退出", bad.exitCode === 1 && badLog.join("").includes("不认这个 Token"), badLog.join(""));

    const noneLog: string[] = [];
    const none = start("node", [entry], { ...env, BOT_TOKEN: "" }, noneLog);
    await waitFor("缺 Token 退出", () => none.exitCode !== null);
    check("没配 Token 时报中文错误并退出", none.exitCode === 1 && noneLog.join("").includes("没有配置 BOT_TOKEN"), noneLog.join(""));
  } finally {
    node.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const target = process.argv[2];
const fake = await startFakeTelegram(TOKEN);
if (target !== "node") await testWorker(fake);
if (target !== "worker") await testNode(fake);
await fake.close();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
