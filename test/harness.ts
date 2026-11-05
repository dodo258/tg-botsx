// 测试脚手架：真实 SQLite（内存库）+ 假 Telegram，从 update 一路跑到 API 调用。
import type { Update } from "@grammyjs/types";
import type { App } from "../src/core/app.ts";
import { handleUpdate } from "../src/core/router.ts";
import { migrate } from "../src/core/schema.ts";
import { loadSettings, saveSetting } from "../src/core/settings.ts";
import type { Settings } from "../src/core/settings.ts";
import { TelegramError } from "../src/core/telegram.ts";
import type { Params, Telegram } from "../src/core/telegram.ts";
import type { Rng } from "../src/core/verify.ts";
import { sqliteDb } from "../src/runtime/sqlite-adapter.ts";

export const OWNER = 1000;
export const ALICE = 2001;
export const BOB = 2002;
export const GROUP = -100500;

export interface Call {
  method: string;
  params: Params;
}

/** 和真实 Telegram 一样拒收超长和 HTML 不合法的消息，否则这类问题只有上线才暴露。 */
export function validateText(method: string, params: Params): void {
  const text = params.text ?? params.caption;
  if (typeof text !== "string") return;
  if (text.length > 4096) throw new TelegramError(method, 400, "Bad Request: message is too long", null);
  if (params.parse_mode !== "HTML") return;
  const allowed = new Set(["b", "i", "u", "s", "a", "code", "pre", "blockquote", "tg-spoiler"]);
  const stack: string[] = [];
  for (const match of text.matchAll(/<(\/?)([a-zA-Z-]*)[^>]*>|<|&(?!(?:lt|gt|amp|quot);)/g)) {
    const whole = match[0];
    const name = match[2] ?? "";
    if (whole === "<" || whole === "&" || !allowed.has(name)) throw new TelegramError(method, 400, `Bad Request: can't parse entities: ${whole}`, null);
    if (match[1] === "/") {
      if (stack.pop() !== name) throw new TelegramError(method, 400, `Bad Request: can't parse entities: ${whole}`, null);
    } else {
      stack.push(name);
    }
  }
  if (stack.length > 0) throw new TelegramError(method, 400, "Bad Request: can't parse entities: 标签没闭合", null);
}

export class FakeTelegram implements Telegram {
  calls: Call[] = [];
  /** 因为超长或 HTML 不合法被拒收的调用，应该永远为空 */
  rejected: string[] = [];
  nextId = 5000;
  /** 按方法名排队的失败，用一次消耗一次 */
  failures = new Map<string, TelegramError[]>();
  responses = new Map<string, unknown>();

  failNext(method: string, code: number, description: string, retryAfter: number | null = null): void {
    const list = this.failures.get(method) ?? [];
    list.push(new TelegramError(method, code, description, retryAfter));
    this.failures.set(method, list);
  }

  async call<T>(method: string, params: Params = {}): Promise<T> {
    this.calls.push({ method, params });
    const failure = this.failures.get(method)?.shift();
    if (failure) throw failure;
    try {
      validateText(method, params);
    } catch (error) {
      // 业务代码会吞掉发送错误，只记日志，所以单独记下来，由每个测试结束时统一断言
      this.rejected.push(`${method}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    return this.respond(method, params) as T;
  }

  async upload<T>(method: string, params: Params): Promise<T> {
    this.calls.push({ method, params });
    return { message_id: this.nextId++ } as T;
  }

  private respond(method: string, params: Params): unknown {
    if (this.responses.has(method)) return this.responses.get(method);
    if (method === "createForumTopic") return { message_thread_id: this.nextId++, name: params.name };
    if (method === "copyMessages" && Array.isArray(params.message_ids)) return params.message_ids.map(() => ({ message_id: this.nextId++ }));
    if (method === "getMe") return { id: 42, username: "demo_bot", has_topics_enabled: false };
    if (["sendMessage", "copyMessage", "forwardMessage", "sendDocument"].includes(method)) return { message_id: this.nextId++ };
    return true;
  }

  named(method: string): Params[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  last(method: string): Params {
    const list = this.named(method);
    const item = list.at(-1);
    if (!item) throw new Error(`没有调用过 ${method}，实际调用：${this.calls.map((call) => call.method).join(", ")}`);
    return item;
  }

  textsTo(chatId: number): string[] {
    return this.named("sendMessage").filter((params) => params.chat_id === chatId).map((params) => String(params.text));
  }

  reset(): void {
    this.calls = [];
  }
}

export const seqRng: Rng = (() => {
  let counter = 0;
  return {
    int: (min: number) => min,
    token: () => `t${++counter}`,
  };
})();

export interface Harness {
  app: App;
  tg: FakeTelegram;
  clock: { now: number };
  deferred: { run(): Promise<void> };
  send(update: Partial<Update>): Promise<void>;
  fromUser(userId: number, text: string, extra?: Record<string, unknown>): Promise<number>;
  fromOwner(text: string, extra?: Record<string, unknown>): Promise<number>;
  fromGroup(staffId: number, text: string, threadId: number | null, extra?: Record<string, unknown>): Promise<number>;
  press(userId: number, chatId: number, messageId: number, data: string, threadId?: number): Promise<void>;
  passVerification(userId: number): Promise<void>;
  set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;
}

export async function makeHarness(options: { owner?: boolean; verify?: boolean } = {}): Promise<Harness> {
  const db = sqliteDb(":memory:");
  await migrate(db);
  const tg = new FakeTelegram();
  const clock = { now: 1_800_000_000 };
  const tasks: (() => Promise<void>)[] = [];
  const logs: string[] = [];
  const app: App = {
    db,
    tg,
    settings: await loadSettings(db),
    rng: seqRng,
    now: () => clock.now,
    nowMs: () => clock.now * 1000,
    defer: (task) => {
      tasks.push(task);
    },
    log: (_level, message, detail) => {
      logs.push(`${message} ${String(detail)}`);
    },
  };
  if (options.owner !== false) await saveSetting(db, app.settings, "ownerId", OWNER);
  if (options.verify === false) await saveSetting(db, app.settings, "verifyMode", "off");

  let updateId = 1;
  let messageId = 100;
  // 每条更新都重新读配置，和真实运行环境一致
  const send = async (update: Partial<Update>) => {
    app.settings = await loadSettings(db);
    await handleUpdate(app, { update_id: updateId++, ...update } as Update);
  };
  const user = (id: number) => ({ id, is_bot: false, first_name: `用户${id}`, username: `u${id}` });

  const harness: Harness = {
    app,
    tg,
    clock,
    deferred: {
      async run() {
        app.settings = await loadSettings(db);
        for (const task of tasks.splice(0)) await task();
      },
    },
    send,
    async fromUser(userId, text, extra = {}) {
      const id = messageId++;
      await send({ message: { message_id: id, date: clock.now, chat: { id: userId, type: "private", first_name: "x" }, from: user(userId), text, ...extra } as never });
      return id;
    },
    async fromOwner(text, extra = {}) {
      const id = messageId++;
      await send({ message: { message_id: id, date: clock.now, chat: { id: OWNER, type: "private", first_name: "o" }, from: user(OWNER), text, ...extra } as never });
      return id;
    },
    async fromGroup(staffId, text, threadId, extra = {}) {
      const id = messageId++;
      await send({
        message: {
          message_id: id,
          date: clock.now,
          chat: { id: GROUP, type: "supergroup", title: "客服", is_forum: true },
          from: user(staffId),
          text,
          ...(threadId === null ? {} : { message_thread_id: threadId, is_topic_message: true }),
          ...extra,
        } as never,
      });
      return id;
    },
    async press(userId, chatId, msgId, data, threadId) {
      await send({
        callback_query: {
          id: "cb",
          from: user(userId),
          chat_instance: "x",
          data,
          message: { message_id: msgId, date: clock.now, chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" }, ...(threadId === undefined ? {} : { message_thread_id: threadId }) },
        } as never,
      });
    },
    async passVerification(userId) {
      const row = await db.prepare("SELECT challenge_id, challenge_token FROM contacts WHERE user_id = ?").bind(userId).first<{ challenge_id: string; challenge_token: string }>();
      if (!row) throw new Error("联系人不存在");
      await harness.press(userId, userId, 1, `v:${row.challenge_id}:${row.challenge_token}`);
    },
    async set(key, value) {
      await saveSetting(db, app.settings, key, value);
    },
  };
  return harness;
}
