// 真实走一遍安装脚本：Docker 构建、启动、认领、备份、恢复、重复安装、卸载。
// 只在有 Docker 且有 root 权限的 Linux 上跑（CI 里跑）。
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

function sudo(command: string, input?: string): { code: number; out: string } {
  const result = spawnSync("sudo", ["-E", "bash", "-c", command], {
    input,
    encoding: "utf8",
    env: { ...process.env, BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: fake.url, TGBOTSX_SOURCE: process.cwd(), TGBOTSX_YES: "1" },
  });
  return { code: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
}

const first = sudo("bash deploy/install.sh");
console.log(first.out.split("\n").slice(-12).join("\n"));
check("安装脚本成功退出", first.code === 0, first.out);
check("输出了认领链接", /start=claim_/.test(first.out));
check("输出里没有 Token 明文", !first.out.includes(TOKEN));
check(".env 权限是 600", (statSync(`${DIR}/.env`).mode & 0o777) === 0o600);
check("tgbot 命令已安装", existsSync("/usr/local/bin/tgbot"));

const code = /claim_([\w-]+)/.exec(first.out)?.[1] ?? "";
fake.queue.push({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1000, type: "private" }, from: { id: 1000, is_bot: false, first_name: "主人" }, text: `/start claim_${code}` } });
await sleep(4000);
check("容器里的机器人收到更新并完成绑定", fake.named("sendMessage").some((m) => String(m.text).includes("绑定成功")), JSON.stringify(fake.calls.slice(-3)));

fake.queue.push({ update_id: 2, message: { message_id: 2, date: 1, chat: { id: 2001, type: "private" }, from: { id: 2001, is_bot: false, first_name: "访客" }, text: "你好" } });
await sleep(4000);
check("陌生人收到验证题", fake.named("sendMessage").some((m) => m.chat_id === 2001));

const status = sudo("tgbot status");
check("tgbot status 可用", status.code === 0 && status.out.includes("tg-botsx"), status.out);

const backup = sudo("tgbot backup");
check("tgbot backup 成功", backup.code === 0, backup.out);
const backups = readdirSync(`${DIR}/backups`);
const backupFile = `${DIR}/backups/${backups[0]}`;
check("备份文件是有效的 SQLite", backups.length === 1 && readFileSync(backupFile).subarray(0, 15).toString() === "SQLite format 3", backups);

// 重复安装：不能丢数据
const again = sudo("bash deploy/install.sh");
check("重复安装成功", again.code === 0, again.out);
check("重复安装不再要求认领（数据还在）", !/start=claim_/.test(again.out) && again.out.includes("已经绑定过管理员"), again.out);

const restored = sudo(`tgbot restore ${backupFile}`, "恢复\n");
check("tgbot restore 成功", restored.code === 0 && restored.out.includes("已恢复"), restored.out);
await sleep(3000);
fake.queue.push({ update_id: 3, message: { message_id: 3, date: 1, chat: { id: 1000, type: "private" }, from: { id: 1000, is_bot: false, first_name: "主人" }, text: "/help" } });
await sleep(4000);
check("恢复后主人身份还在", fake.named("sendMessage").some((m) => String(m.text).includes("怎么回复")));

const stoppedKeep = sudo("tgbot uninstall", "\n卸载\n");
check("卸载（保留数据）成功", stoppedKeep.code === 0 && stoppedKeep.out.includes("数据保留"), stoppedKeep.out);
const volumes = execSync("sudo docker volume ls --format '{{.Name}}'", { encoding: "utf8" });
check("卸载后数据卷还在", volumes.includes("tg-botsx_data"), volumes);

const reinstall = sudo("bash deploy/install.sh");
check("重新安装后接着用旧数据", reinstall.code === 0 && reinstall.out.includes("已经绑定过管理员"), reinstall.out);

await fake.close();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
