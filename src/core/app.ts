// 运行环境注入给业务代码的全部依赖。Worker 和 Node 各组装一份。
import type { Db } from "./db.ts";
import type { Settings } from "./settings.ts";
import type { Telegram } from "./telegram.ts";
import type { Rng } from "./verify.ts";

export interface App {
  db: Db;
  tg: Telegram;
  settings: Settings;
  rng: Rng;
  /** 当前 Unix 秒 */
  now(): number;
  /** 当前毫秒，只用于媒体组这类亚秒级判断 */
  nowMs(): number;
  /** 稍后执行。Worker 用 waitUntil，Node 用定时器。 */
  defer(task: () => Promise<void>, delayMs: number): void;
  log(level: "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export function isOwner(app: App, userId: number | undefined): boolean {
  return userId !== undefined && app.settings.ownerId === userId;
}
