// 跑一个机器人：长轮询加定时任务。一个进程里可以同时跑很多个，互不共享状态。
import type { Update } from "@grammyjs/types";
import type { App } from "../core/app.ts";
import { tick } from "../core/maintenance.ts";
import { handleUpdate, isUpdate } from "../core/router.ts";
import { migrate } from "../core/schema.ts";
import { loadSettings } from "../core/settings.ts";
import { ALLOWED_UPDATES, fetchBot, syncCommands } from "../core/setup.ts";
import { createTelegram, TelegramError } from "../core/telegram.ts";
import { cryptoRng } from "../core/verify.ts";
import { sqliteDb } from "./sqlite-adapter.ts";

const POLL_TIMEOUT_SECONDS = 30;
const TICK_INTERVAL_MS = 20_000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface BotSpec {
  /** 日志前缀，默认机器人不带 */
  label: string;
  token: string;
  dbFile: string;
  apiBase?: string | undefined;
  /** 启动成功后调用一次 */
  onConnected(app: App, username: string): Promise<void> | void;
  /** Token 失效这类重试也没用的错误 */
  onFatal(message: string): void;
}

export interface RunningBot {
  token: string;
  state(): "connecting" | "online" | "failed";
  stop(): Promise<void>;
}

export function startBot(spec: BotSpec): RunningBot {
  const prefix = spec.label ? `[${spec.label}] ` : "";
  const db = sqliteDb(spec.dbFile);
  const tg = createTelegram({ token: spec.token, apiBase: spec.apiBase, maxRetryAfter: 30 });
  const pollClient = createTelegram({ token: spec.token, apiBase: spec.apiBase, timeoutMs: (POLL_TIMEOUT_SECONDS + 15) * 1000 });
  const pending = new Set<Promise<void>>();
  let stopping = false;
  let handling = false;
  let state: "connecting" | "online" | "failed" = "connecting";
  let timer: ReturnType<typeof setInterval> | undefined;

  const buildApp = async (): Promise<App> => ({
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
          console.error(`${prefix}后台任务失败：`, error instanceof Error ? error.message : String(error));
        })
        .finally(() => pending.delete(job));
      pending.add(job);
    },
    log(level, message, detail) {
      const line = `${new Date().toISOString()} ${level === "error" ? "错误" : level === "warn" ? "警告" : "信息"} ${prefix}${message}${detail === undefined ? "" : `：${String(detail)}`}`;
      if (level === "error") console.error(line);
      else console.log(line);
    },
  });

  const connect = async (): Promise<boolean> => {
    let backoff = 5000;
    while (!stopping) {
      try {
        await migrate(db);
        const app = await buildApp();
        // 这个 Token 以前被别的程序设过 Webhook 的话要先删，否则长轮询会报 409
        await tg.call("deleteWebhook", { drop_pending_updates: false });
        const bot = await fetchBot(app);
        await syncCommands(app);
        console.log(`${prefix}已连接 @${bot.username}，数据在 ${spec.dbFile}`);
        await spec.onConnected(app, bot.username);
        state = "online";
        return true;
      } catch (error) {
        if (error instanceof TelegramError && error.code === 401) {
          state = "failed";
          spec.onFatal(`${prefix}Telegram 不认这个 Token（401）。到 @BotFather 核对。`);
          return false;
        }
        console.error(`${prefix}连不上 Telegram，${backoff / 1000} 秒后重试：`, error instanceof Error ? error.message : String(error));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    return false;
  };

  const poll = async (): Promise<void> => {
    let offset = 0;
    let backoff = 1000;
    while (!stopping) {
      try {
        const updates = await pollClient.call<unknown[]>("getUpdates", { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ALLOWED_UPDATES });
        backoff = 1000;
        for (const raw of updates) {
          // 停止后不再处理：没确认的更新下次还会收到
          if (stopping) return;
          if (!isUpdate(raw)) continue;
          const update: Update = raw;
          offset = update.update_id + 1;
          handling = true;
          await handleUpdate(await buildApp(), update);
          handling = false;
        }
      } catch (error) {
        handling = false;
        if (stopping) return;
        if (error instanceof TelegramError && error.code === 409) {
          console.error(`${prefix}另一个程序正在用这个 Token 收消息。同一个 Token 只能跑一份，请停掉另一份。10 秒后重试。`);
          await sleep(10_000);
          continue;
        }
        if (error instanceof TelegramError && error.code === 401) {
          state = "failed";
          spec.onFatal(`${prefix}Token 已失效（401）。到 @BotFather 拿新的再更换。`);
          return;
        }
        console.error(`${prefix}收消息失败，${backoff / 1000} 秒后重试：`, error instanceof Error ? error.message : String(error));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  };

  const done = (async () => {
    if (!(await connect())) return;
    let ticking = false;
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      buildApp()
        .then((app) => tick(app))
        .catch((error: unknown) => {
          console.error(`${prefix}定时任务失败：`, error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          ticking = false;
        });
    }, TICK_INTERVAL_MS);
    await poll();
  })().catch((error: unknown) => {
    console.error(`${prefix}机器人异常退出：`, error instanceof Error ? error.message : String(error));
  });

  return {
    token: spec.token,
    state: () => state,
    async stop() {
      stopping = true;
      clearInterval(timer);
      // 长轮询挂着时不等它返回，最多再多收一次，下次重新确认
      await Promise.race([done, sleep(2000)]);
      for (let waited = 0; handling && waited < 100; waited++) await sleep(100);
      await Promise.allSettled([...pending]);
      try {
        db.close();
      } catch (error) {
        console.error(`${prefix}关闭数据库失败：`, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
