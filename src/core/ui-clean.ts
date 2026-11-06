// 自动清理操作机器人留下的消息：面板、设置页、提示、点过的命令。
// 只记主动登记的消息，默认一条都不删；转来的私信、管理员的回复走的是另一条路，不会进这里。
import type { App } from "./app.ts";
import { num } from "./db.ts";
import type { Params, Telegram } from "./telegram.ts";
import { TelegramError } from "./telegram.ts";

const BATCH = 30;
/** Telegram 不让删 48 小时以上的消息，再试也没用 */
const TOO_OLD = 47 * 3600;

export async function rememberUi(app: App, chatId: number, messageId: number): Promise<void> {
  try {
    await app.db.prepare("INSERT OR IGNORE INTO ui_messages(chat_id, message_id, created_at) VALUES(?, ?, ?)").bind(chatId, messageId, app.now()).run();
  } catch (error) {
    // 记不下来最多是少删一条，不能影响正常操作
    app.log("warn", "记录菜单消息失败", error instanceof Error ? error.message : String(error));
  }
}

/** 主人私聊里，操作期间机器人发的消息都登记。留底要保留的，用 keepTg 发。 */
export function trackedApp(app: App, chatId: number): App {
  if (chatId !== app.settings.ownerId) return app;
  const tg: Telegram = {
    upload: (method, params, field, file, name, type) => app.tg.upload(method, params, field, file, name, type),
    async call<T>(method: string, params: Params = {}): Promise<T> {
      const result = await app.tg.call<T>(method, params);
      if (method === "sendMessage" && params.chat_id === chatId && typeof result === "object" && result !== null && "message_id" in result && typeof result.message_id === "number") {
        await rememberUi(app, chatId, result.message_id);
      }
      return result;
    },
  };
  return { ...app, tg, keepTg: app.tg };
}

export async function cleanUi(app: App): Promise<void> {
  const hours = app.settings.uiCleanHours;
  const now = app.now();
  await app.db.prepare("DELETE FROM ui_messages WHERE created_at < ?").bind(now - TOO_OLD).run();
  if (hours <= 0) return;
  const rows = await app.db.prepare("SELECT chat_id, message_id FROM ui_messages WHERE created_at <= ? ORDER BY created_at LIMIT ?").bind(now - hours * 3600, BATCH).all<{ chat_id: unknown; message_id: unknown }>();
  for (const row of rows) {
    const chatId = num(row.chat_id);
    const messageId = num(row.message_id);
    try {
      await app.tg.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch (error) {
      // 限流和网络问题下一轮再删。其他的（比如已经被手动删了）删不掉就算了
      if (!(error instanceof TelegramError) || error.code === 429 || error.code === 0 || error.code >= 500) return;
    }
    await app.db.prepare("DELETE FROM ui_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, messageId).run();
  }
}
