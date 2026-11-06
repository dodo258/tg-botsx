// 端到端：起真实的 Node 进程，对着假 Telegram 跑一遍。
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

async function testNode(fake: FakeServer): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "tg-botsx-node-"));
  const env = { BOT_TOKEN: TOKEN, DATA_DIR: dataDir, TELEGRAM_API_BASE: fake.url, NODE_NO_WARNINGS: "1" };
  const log: string[] = [];
  const entry = "src/runtime/node.ts";
  const node = start("node", [entry], env, log);
  try {
    const linked = await waitFor("打印认领链接", () => log.join("").includes("start=claim_"));
    check("启动后打印认领链接", linked, log.join(""));
    check("启动后打印配对图案", /配对图案：\S+ \S+/.test(log.join("")), log.join(""));
    check("启动时删除旧 Webhook", fake.named("deleteWebhook").length === 1);
    const code = /claim_([\w-]+)/.exec(log.join(""))?.[1] ?? "";

    fake.queue.push(textUpdate(OWNER, `/start claim_${code}`, 1));
    check("长轮询收到认领并绑定", await waitFor("绑定", () => fake.named("sendMessage").some((m) => String(m.text).includes("绑定成功"))));

    fake.queue.push(textUpdate(ALICE, "你好", 2));
    check("陌生人收到验证题", await waitFor("验证题", () => fake.named("sendMessage").some((m) => m.chat_id === ALICE && String(m.text).includes("答一道题"))));

    fake.queue.push(textUpdate(OWNER, "/status", 3));
    check("管理员命令可用", await waitFor("状态", () => fake.named("sendMessage").some((m) => String(m.text).includes("运行状态"))));

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
    check("日志没有泄露 Token", !conflictFree.includes(TOKEN) && !log.join("").includes(TOKEN));

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

const fake = await startFakeTelegram(TOKEN);
await testNode(fake);
await fake.close();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
