// 真实走一遍安装脚本：Docker 构建、启动、认领、备份、恢复、重复安装、卸载。
// 只在有 Docker 且有 root 权限的 Linux 上跑（CI 里跑）。
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { startFakeTelegram } from "./fake-telegram.ts";

const TOKEN = "123456:DOCKER_SMOKE_TOKEN";
const DIR = "/opt/tg-botsx";
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "通过" : "失败"}  ${name}${ok || detail === undefined ? "" : `\n      实际：${String(detail)}`}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const hostIp = Object.values(networkInterfaces()).flat().find((item) => item && item.family === "IPv4" && !item.internal)?.address;
if (!hostIp) throw new Error("找不到本机 IP");
const fake = await startFakeTelegram(TOKEN, { host: "0.0.0.0", port: 18999, publicHost: hostIp });

// 必须异步：假 Telegram 和这个脚本在同一个进程，spawnSync 会卡住事件循环，假服务就响应不了
function sudo(command: string, input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-E", "bash", "-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: fake.url, TGBOTSX_SOURCE: process.cwd(), TGBOTSX_YES: "1" },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.stdin.end(input ?? "");
  });
}

const first = await sudo("bash deploy/install.sh");
console.log(first.out.split("\n").slice(-12).join("\n"));
check("安装脚本成功退出", first.code === 0, first.out);
check("输出了认领链接", /start=claim_/.test(first.out));
check("输出里没有 Token 明文", !first.out.includes(TOKEN));
check(".env 权限是 600", execSync(`sudo stat -c %a ${DIR}/.env`, { encoding: "utf8" }).trim() === "600");
check("tgbot 命令已安装", existsSync("/usr/local/bin/tgbot"));

const code = /claim_([\w-]+)/.exec(first.out)?.[1] ?? "";
fake.queue.push({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1000, type: "private" }, from: { id: 1000, is_bot: false, first_name: "主人" }, text: `/start claim_${code}` } });
await sleep(4000);
check("容器里的机器人收到更新并完成绑定", fake.named("sendMessage").some((m) => String(m.text).includes("绑定成功")), JSON.stringify(fake.calls.slice(-3)));

fake.queue.push({ update_id: 2, message: { message_id: 2, date: 1, chat: { id: 2001, type: "private" }, from: { id: 2001, is_bot: false, first_name: "访客" }, text: "你好" } });
await sleep(4000);
check("陌生人收到验证题", fake.named("sendMessage").some((m) => m.chat_id === 2001));

const status = await sudo("tgbot status");
check("tgbot status 可用", status.code === 0 && status.out.includes("tg-botsx"), status.out);

const backup = await sudo("tgbot backup");
check("tgbot backup 成功", backup.code === 0, backup.out);
// 备份目录是 root 专属（700），要用 sudo 读
const listed = execSync(`sudo ls ${DIR}/backups`, { encoding: "utf8" }).trim().split("\n");
const backupFile = `${DIR}/backups/${listed[0]}`;
const header = execSync(`sudo head -c 15 ${backupFile}`, { encoding: "utf8" });
const mode = execSync(`sudo stat -c %a ${backupFile}`, { encoding: "utf8" }).trim();
check("备份文件是有效的 SQLite，权限 600", listed.length === 1 && header === "SQLite format 3" && mode === "600", `${listed.join(",")} ${header} ${mode}`);

// 重复安装：不能丢数据
const again = await sudo("bash deploy/install.sh");
check("重复安装成功", again.code === 0, again.out);
check("重复安装不再要求认领（数据还在）", !/start=claim_/.test(again.out) && again.out.includes("已经绑定过管理员"), again.out);

const restored = await sudo(`tgbot restore ${backupFile}`, "恢复\n");
check("tgbot restore 成功", restored.code === 0 && restored.out.includes("已恢复"), restored.out);
await sleep(3000);
fake.queue.push({ update_id: 3, message: { message_id: 3, date: 1, chat: { id: 1000, type: "private" }, from: { id: 1000, is_bot: false, first_name: "主人" }, text: "/help" } });
await sleep(4000);
check("恢复后主人身份还在", fake.named("sendMessage").some((m) => String(m.text).includes("怎么回复")));

// umask 077 下更新：程序文件权限错了容器里的 node 用户就读不了，机器人起不来
const updated = await sudo("umask 077; tgbot update");
check("tgbot update 成功，机器人重新连上", updated.code === 0 && updated.out.includes("已连上 Telegram"), updated.out);
check("更新后程序文件别人读得到", execSync(`sudo stat -c %a ${DIR}/src`, { encoding: "utf8" }).trim() === "755");
await sleep(3000);
const helpCount = fake.named("sendMessage").filter((m) => String(m.text).includes("怎么回复")).length;
fake.queue.push({ update_id: 4, message: { message_id: 4, date: 1, chat: { id: 1000, type: "private" }, from: { id: 1000, is_bot: false, first_name: "主人" }, text: "/help" } });
await sleep(4000);
check("更新后机器人还能正常工作", fake.named("sendMessage").filter((m) => String(m.text).includes("怎么回复")).length === helpCount + 1);

// 机器人停了也要能更新，这正是最需要修复的时候
await sudo(`cd ${DIR} && docker compose stop bot`);
const updatedWhileDown = await sudo("tgbot update");
check("机器人停着也能更新", updatedWhileDown.code === 0 && updatedWhileDown.out.includes("跳过这次备份"), updatedWhileDown.out);

// .env 里配的反代地址，环境变量没给时也要生效
const viaEnvFile = await new Promise<{ code: number; out: string }>((resolve, reject) => {
  execSync(`sudo sh -c "grep -q '^TELEGRAM_API_BASE=' ${DIR}/.env"`);
  const child = spawn("sudo", ["env", "-u", "TELEGRAM_API_BASE", "-u", "BOT_TOKEN", "TGBOTSX_YES=1", `TGBOTSX_SOURCE=${process.cwd()}`, "bash", "deploy/install.sh"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.on("error", reject);
  child.on("close", (code) => resolve({ code: code ?? 1, out }));
});
check("从 .env 读反代地址校验 Token", viaEnvFile.code === 0 && viaEnvFile.out.includes("Token 有效"), viaEnvFile.out);

const stoppedKeep = await sudo("tgbot uninstall", "\n卸载\n");
check("卸载（保留数据）成功", stoppedKeep.code === 0 && stoppedKeep.out.includes("数据保留"), stoppedKeep.out);
const volumes = execSync("sudo docker volume ls --format '{{.Name}}'", { encoding: "utf8" });
check("卸载后数据卷还在", volumes.includes("tg-botsx_data"), volumes);

const reinstall = await sudo("bash deploy/install.sh");
check("重新安装后接着用旧数据", reinstall.code === 0 && reinstall.out.includes("已经绑定过管理员"), reinstall.out);

// 公开仓库的真实路径：README 里那条 bash <(curl ...)，不用本地源码，从 GitHub 下载
const repo = process.env.GITHUB_REPOSITORY;
if (repo) {
  const viaCurl = await sudo(`unset TGBOTSX_SOURCE; export TGBOTSX_REPO=${repo}; bash <(curl -fsSL https://raw.githubusercontent.com/${repo}/main/deploy/install.sh)`);
  check("README 的 curl 安装命令可用", viaCurl.code === 0 && viaCurl.out.includes("已连上 Telegram"), viaCurl.out);
  const updateOnline = await sudo(`unset TGBOTSX_SOURCE; export TGBOTSX_REPO=${repo}; tgbot update`);
  check("tgbot update 能从 GitHub 下载更新", updateOnline.code === 0 && updateOnline.out.includes("已连上 Telegram"), updateOnline.out);
}

await fake.close();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
