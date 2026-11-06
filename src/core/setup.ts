// 启动时的设置：读取机器人信息、设置命令菜单、认领管理员。
import type { Message, User } from "@grammyjs/types";
import type { App } from "./app.ts";
import { renderPanel } from "./menus.ts";
import { saveSetting } from "./settings.ts";

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "message_reaction", "my_chat_member"];
const CLAIM_TTL = 10 * 60;

const USER_COMMANDS = [{ command: "start", description: "开始" }];

// 菜单里只放入口，其他操作都在面板里点按钮。完整命令照样能打，见 /help
const STAFF_COMMANDS = [
  { command: "menu", description: "打开管理面板" },
  { command: "help", description: "怎么回复消息" },
];

const OWNER_COMMANDS = STAFF_COMMANDS;

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

/** 配对图案。带上名字：有些服务器终端显示不了 emoji，看文字也能对上。 */
export const CLAIM_PAIRS = ["🍎 苹果", "🚗 汽车", "🐶 小狗", "🌙 月亮", "⚽️ 足球", "🎸 吉他", "🌵 仙人掌", "🍕 披萨", "🚀 火箭", "🐟 小鱼", "🔑 钥匙", "☂️ 雨伞"];

export async function createClaim(app: App): Promise<string> {
  const code = app.rng.token();
  await saveSetting(app.db, app.settings, "claimPair", CLAIM_PAIRS[app.rng.int(0, CLAIM_PAIRS.length - 1)] ?? "");
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
  await becomeOwner(app, message.from, message.chat.id);
  return true;
}

/** 名字是对方自己填的，去掉控制字符，防止伪造日志和终端转义 */
function displayName(user: User): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").replace(/\p{Cc}/gu, "");
  return `${name}${user.username ? ` @${user.username}` : ""}（ID ${user.id}）`;
}

async function becomeOwner(app: App, user: User, chatId: number): Promise<void> {
  const previous = app.settings.ownerId;
  await saveSetting(app.db, app.settings, "ownerId", user.id);
  await saveSetting(app.db, app.settings, "claimCode", "");
  await saveSetting(app.db, app.settings, "claimExpiresAt", 0);
  await saveSetting(app.db, app.settings, "claimPair", "");
  await syncCommands(app);
  // 安装脚本靠这行告诉部署的人是谁绑定的
  app.log("info", "已绑定管理员", displayName(user));
  await app.tg.call("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      "<b>绑定成功，你现在是这个机器人的管理员。</b>\n\n" +
      "别人发给机器人的消息会转到这里，<b>回复那条消息</b>就是回复对方，对方看不到你的账号。\n\n" +
      "现在用另一个账号给机器人发条消息试试。下面是管理面板，所有操作点按钮就行。以后想打开它，点输入框旁边的菜单。",
  });
  const panel = await renderPanel(app, true);
  await app.tg.call("sendMessage", { chat_id: chatId, text: panel.text, parse_mode: "HTML", reply_markup: panel.keyboard });
  if (previous !== null && previous !== user.id) {
    await app.tg.call("sendMessage", { chat_id: previous, text: "这个机器人的管理员已被更换。如果不是你操作的，请立刻去 @BotFather 重置 Token。" }).catch((error: unknown) => {
      app.log("warn", "通知原管理员失败", error instanceof Error ? error.message : String(error));
    });
  }
}

/**
 * 首次绑定在机器人窗口里点按钮完成，不用点链接。
 * 按钮谁都能看到，Telegram 也查不到机器人是谁创建的，所以要点中只显示在服务器终端的图案。
 * 只在还没有管理员、且认领时限内开放；已有管理员时换人仍然要服务器上生成的链接。
 */
export function firstClaimOpen(app: App): boolean {
  return app.settings.ownerId === null && app.settings.claimExpiresAt > app.now() && app.settings.claimPair !== "";
}

export async function sendClaimPrompt(app: App, chatId: number): Promise<void> {
  const rows = [];
  for (let start = 0; start < CLAIM_PAIRS.length; start += 3) {
    rows.push(CLAIM_PAIRS.slice(start, start + 3).map((text, index) => ({ text, callback_data: `claim:${start + index}` })));
  }
  await app.tg.call("sendMessage", {
    chat_id: chatId,
    text: "这个机器人还没有管理员。\n\n是你部署的话，看一眼服务器终端显示的配对图案，点下面一样的那个就绑定好了。\n只有一次机会，点错按钮就失效。",
    reply_markup: { inline_keyboard: rows },
  });
}

export type ClaimResult = "ok" | "wrong" | "closed";

export async function claimByButton(app: App, user: User, chatId: number, choice: string): Promise<ClaimResult> {
  if (!firstClaimOpen(app)) return "closed";
  // 先查是不是数字：Number("") 是 0，空的按钮数据会被当成第 0 个图案
  if (!/^\d+$/.test(choice) || CLAIM_PAIRS[Number(choice)] !== app.settings.claimPair) {
    // 只关按钮，链接是服务器才有的秘密，仍然有效。否则别人故意点错就能把部署的人挡在外面
    await saveSetting(app.db, app.settings, "claimPair", "");
    app.log("warn", "绑定按钮已失效", `${displayName(user)} 点错了配对图案`);
    return "wrong";
  }
  await becomeOwner(app, user, chatId);
  return "ok";
}
