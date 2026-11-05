// 启动时的设置：读取机器人信息、设置命令菜单、认领管理员。
import type { Message } from "@grammyjs/types";
import type { App } from "./app.ts";
import { saveSetting } from "./settings.ts";

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "message_reaction", "my_chat_member"];
const CLAIM_TTL = 10 * 60;

const USER_COMMANDS = [{ command: "start", description: "开始" }];

const STAFF_COMMANDS = [
  { command: "list", description: "最近会话" },
  { command: "search", description: "搜索联系人" },
  { command: "history", description: "聊天记录" },
  { command: "note", description: "给联系人加备注" },
  { command: "q", description: "快捷回复" },
  { command: "del", description: "撤回（回复自己发的消息）" },
  { command: "block", description: "屏蔽联系人" },
  { command: "unblock", description: "解除屏蔽" },
  { command: "filtered", description: "隔离区" },
  { command: "stats", description: "统计" },
  { command: "help", description: "帮助" },
];

const OWNER_COMMANDS = [
  ...STAFF_COMMANDS.slice(0, -1),
  { command: "settings", description: "设置" },
  { command: "rule", description: "关键词自动回复" },
  { command: "broadcast", description: "群发（回复一条消息）" },
  { command: "status", description: "运行状态" },
  { command: "cleanup", description: "清理记录" },
  { command: "export", description: "导出数据" },
  { command: "help", description: "帮助" },
];

export async function syncCommands(app: App): Promise<void> {
  await app.tg.call("setMyCommands", { commands: USER_COMMANDS });
  if (app.settings.ownerId !== null) {
    await app.tg.call("setMyCommands", { commands: OWNER_COMMANDS, scope: { type: "chat", chat_id: app.settings.ownerId } });
  }
  if (app.settings.deskMode === "group" && app.settings.groupId !== null) {
    await app.tg.call("setMyCommands", { commands: STAFF_COMMANDS, scope: { type: "chat", chat_id: app.settings.groupId } });
  }
}

export async function fetchBot(app: App): Promise<{ id: number; username: string; hasTopics: boolean }> {
  const me = await app.tg.call<{ id: number; username?: string; has_topics_enabled?: boolean }>("getMe");
  if (me.username && me.username !== app.settings.botUsername) await saveSetting(app.db, app.settings, "botUsername", me.username);
  return { id: me.id, username: me.username ?? "", hasTopics: me.has_topics_enabled === true };
}

export async function createClaim(app: App): Promise<string> {
  const code = app.rng.token();
  await saveSetting(app.db, app.settings, "claimCode", code);
  await saveSetting(app.db, app.settings, "claimExpiresAt", app.now() + CLAIM_TTL);
  return code;
}

export function claimLink(username: string, code: string): string {
  return `https://t.me/${username}?start=claim_${code}`;
}

/** 处理认领链接。返回 true 表示这是一条认领消息，不再往下走。 */
export async function tryClaim(app: App, message: Message): Promise<boolean> {
  const match = /^\/start(?:@\w+)?\s+claim_([\w-]+)$/.exec(message.text ?? "");
  if (!match || message.chat.type !== "private" || !message.from) return false;
  const valid = app.settings.claimCode !== "" && app.settings.claimCode === match[1] && app.settings.claimExpiresAt > app.now();
  if (!valid) {
    await app.tg.call("sendMessage", { chat_id: message.chat.id, text: "这个认领链接已失效。在服务器上运行 tgbot claim 重新生成。" });
    return true;
  }
  const previous = app.settings.ownerId;
  await saveSetting(app.db, app.settings, "ownerId", message.from.id);
  await saveSetting(app.db, app.settings, "claimCode", "");
  await saveSetting(app.db, app.settings, "claimExpiresAt", 0);
  await syncCommands(app);
  await app.tg.call("sendMessage", {
    chat_id: message.chat.id,
    parse_mode: "HTML",
    text:
      "<b>绑定成功，你现在是这个机器人的管理员。</b>\n\n" +
      "别人发给机器人的消息会转到这里，<b>回复那条消息</b>就是回复对方，对方看不到你的账号。\n\n" +
      "现在用另一个账号给机器人发条消息试试。\n" +
      "/settings 改欢迎语和验证方式，/help 看全部命令。",
  });
  if (previous !== null && previous !== message.from.id) {
    await app.tg.call("sendMessage", { chat_id: previous, text: "这个机器人的管理员已被更换。如果不是你操作的，请立刻去 @BotFather 重置 Token。" }).catch((error: unknown) => {
      app.log("warn", "通知原管理员失败", error instanceof Error ? error.message : String(error));
    });
  }
  return true;
}
