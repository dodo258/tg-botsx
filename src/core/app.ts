// 注入给业务代码的全部依赖。程序里由 runtime/node.ts 组装，测试里由 test/harness.ts 组装。
import type { Db } from "./db.ts";
import type { Settings } from "./settings.ts";
import type { Telegram } from "./telegram.ts";
import type { Rng } from "./verify.ts";

export interface App {
  /** 进程或这个机器人正在停止。长任务要看它，及时收手 */
  isStopping?: () => boolean;
  db: Db;
  tg: Telegram;
  settings: Settings;
  rng: Rng;
  /** 当前 Unix 秒 */
  now(): number;
  /** 当前毫秒，只用于媒体组这类亚秒级判断 */
  nowMs(): number;
  /** 稍后执行，比如媒体组攒齐后再发。 */
  defer(task: () => Promise<void>, delayMs: number): void;
  log(level: "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export function isOwner(app: App, userId: number | undefined): boolean {
  return userId !== undefined && app.settings.ownerId === userId;
}
