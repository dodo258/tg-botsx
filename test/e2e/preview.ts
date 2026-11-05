// 本地预览设置页：真实 Worker + 假 Telegram，不需要真 Token。预览时 Token 填 123456:PREVIEW。
import { spawn } from "node:child_process";
import { startFakeTelegram } from "./fake-telegram.ts";

const TOKEN = "123456:PREVIEW";
const fake = await startFakeTelegram(TOKEN);
const worker = spawn("npx", ["wrangler", "dev", "--port", "18790", "--var", `BOT_TOKEN:${TOKEN}`, "--var", `TELEGRAM_API_BASE:${fake.url}`, "--persist-to", ".wrangler/preview", "--show-interactive-dev-session=false"], { stdio: "inherit" });
process.on("SIGTERM", () => worker.kill("SIGTERM"));
worker.on("exit", (code) => process.exit(code ?? 0));
