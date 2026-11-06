// 启动时的设置：读取机器人信息、设置命令菜单、认领管理员。
import type { Message, User } from "@grammyjs/types";
import type { App } from "./app.ts";
import { releaseAllHeld } from "./inbound.ts";
import { renderPanel } from "./menus.ts";
import { shuffle } from "./verify.ts";
import { saveSetting } from "./settings.ts";
import type { Settings } from "./settings.ts";

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "message_reaction", "my_chat_member"];
// 第一次绑定要等朋友有空，给够时间。已有管理员时的换人链接等于交出控制权，要短
const FIRST_CLAIM_TTL = 7 * 86_400;
const SHOWN_PAIRS = 6;
const TRANSFER_TTL = 10 * 60;

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

/** 配对图案的备选。带上名字：有些服务器终端显示不了 emoji，看文字也能对上。每次只拿出几个给人点 */
export const CLAIM_PAIRS = ["🍎 苹果", "🚗 汽车", "🐶 小狗", "🌙 月亮", "⚽️ 足球", "🎸 吉他", "🌵 仙人掌", "🍕 披萨", "🚀 火箭", "🐟 小鱼", "🔑 钥匙", "☂️ 雨伞"];

export interface ClaimOptions {
  mode: Settings["claimMode"];
  user?: string;
}

function pickChoices(app: App, pair: string): string {
  const others = shuffle(app.rng, CLAIM_PAIRS.filter((item) => item !== pair)).slice(0, SHOWN_PAIRS - 1);
  return shuffle(app.rng, [pair, ...others]).join("\n");
}

export async function createClaim(app: App, options: ClaimOptions = { mode: "pair" }): Promise<string> {
  const code = app.rng.token();
  const ttl = app.settings.ownerId === null ? FIRST_CLAIM_TTL : TRANSFER_TTL;
  await saveSetting(app.db, app.settings, "claimMode", options.mode);
  await saveSetting(app.db, app.settings, "claimUser", options.user ?? "");
  const pair = options.mode === "pair" ? (CLAIM_PAIRS[app.rng.int(0, CLAIM_PAIRS.length - 1)] ?? "") : "";
  await saveSetting(app.db, app.settings, "claimPair", pair);
  await saveSetting(app.db, app.settings, "claimChoices", pair ? pickChoices(app, pair) : "");
  await saveSetting(app.db, app.settings, "claimCode", code);
  await saveSetting(app.db, app.settings, "claimExpiresAt", app.now() + ttl);
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
function cleanName(user: User): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").replace(/\p{Cc}/gu, "");
}

function displayName(user: User): string {
  return `${cleanName(user)}${user.username ? ` @${user.username}` : ""}（ID ${user.id}）`;
}

async function becomeOwner(app: App, user: User, chatId: number): Promise<void> {
  const previous = app.settings.ownerId;
  await saveSetting(app.db, app.settings, "ownerId", user.id);
  await saveSetting(app.db, app.settings, "ownerName", cleanName(user));
  await saveSetting(app.db, app.settings, "ownerUsername", user.username ?? "");
  // 换了人，旧管理员的话题群和选中状态都不能留：否则客户消息还发到他的群，群成员还能回复
  if (previous !== null && previous !== user.id) {
    await saveSetting(app.db, app.settings, "deskMode", "dm");
    await saveSetting(app.db, app.settings, "groupId", null);
    await app.db.prepare("UPDATE contacts SET thread_id = NULL, thread_claim_at = NULL").run();
    await app.db.prepare("DELETE FROM staff_state").run();
  }
  // 新管理员没见过任何卡片，下一条消息要带上是谁发的
  await saveSetting(app.db, app.settings, "lastCardUser", 0);
  await saveSetting(app.db, app.settings, "claimCode", "");
  await saveSetting(app.db, app.settings, "claimExpiresAt", 0);
  await saveSetting(app.db, app.settings, "claimPair", "");
  // 安装脚本靠这行告诉部署的人是谁绑定的
  app.log("info", "已绑定管理员", displayName(user));
  // 绑定已经成立。后面每一步都只是通知，网络出错不能让空档期的消息卡住
  const quietly = (what: string, job: Promise<unknown>) =>
    job.catch((error: unknown) => {
      app.log("warn", what, error instanceof Error ? error.message : String(error));
    });
  await quietly("同步命令菜单失败", syncCommands(app));
  await quietly("发送绑定成功提示失败", app.tg.call("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      "<b>绑定成功，你现在是这个机器人的管理员。</b>\n\n" +
      "别人发给机器人的消息会转到这里，<b>回复那条消息</b>就是回复对方，对方看不到你的账号。\n\n" +
      "现在用另一个账号给机器人发条消息试试。下面是管理面板，所有操作点按钮就行。以后想打开它，点输入框旁边的菜单。",
  }));
  const panel = await renderPanel(app, true, user.id);
  await quietly("发送管理面板失败", app.tg.call("sendMessage", { chat_id: chatId, text: panel.text, parse_mode: "HTML", reply_markup: panel.keyboard }));
  await quietly("转发空档期的消息失败", releaseAllHeld(app));
  if (previous !== null && previous !== user.id) {
    await app.tg.call("sendMessage", { chat_id: previous, text: "这个机器人的管理员已被更换。如果不是你操作的，请立刻去 @BotFather 重置 Token。" }).catch((error: unknown) => {
      app.log("warn", "通知原管理员失败", error instanceof Error ? error.message : String(error));
    });
  }
}

/**
 * 首次绑定在机器人窗口里点按钮完成，不用点链接。按钮谁都可能看到，Telegram 也查不到机器人是谁创建的，所以分三种：
 * pair 要点中只显示在服务器上的图案；user 被指定的人私聊就直接绑定（Telegram 核实的身份）；open 谁先点算谁，靠网页上能看到是谁、能重置兜底。
 * 只在还没有管理员、且时限内开放；已有管理员时换人只能用服务器上生成的链接。
 */
export function firstClaimOpen(app: App, user: User): boolean {
  const s = app.settings;
  if (s.ownerId !== null || s.claimExpiresAt <= app.now()) return false;
  if (s.claimMode === "open") return true;
  if (s.claimMode === "user") return (user.username ?? "").toLowerCase() === s.claimUser;
  if (s.claimMode === "link") return false;
  return s.claimPair !== "";
}

export async function sendClaimPrompt(app: App, chatId: number): Promise<void> {
  if (app.settings.claimMode !== "pair") {
    await app.tg.call("sendMessage", {
      chat_id: chatId,
      text: "这个机器人还没有管理员。点下面的按钮，你就是它的管理员了。",
      reply_markup: { inline_keyboard: [[{ text: "👑 成为管理员", callback_data: "claim" }]] },
    });
    return;
  }
  // 选项在创建时定好，每次都一样。如果每次随机，多看几次取交集就能算出哪个对
  if (!app.settings.claimChoices) await saveSetting(app.db, app.settings, "claimChoices", pickChoices(app, app.settings.claimPair));
  const chosen = app.settings.claimChoices.split("\n");
  const buttons = chosen.map((text) => ({ text, callback_data: `claim:${CLAIM_PAIRS.indexOf(text)}` }));
  const rows = [buttons.slice(0, 3), buttons.slice(3)];
  await app.tg.call("sendMessage", {
    chat_id: chatId,
    text: "这个机器人还没有管理员。\n\n是你部署的话，看一眼服务器上显示的配对图案，点下面一样的那个就绑定好了。\n只有一次机会，点错按钮就失效。",
    reply_markup: { inline_keyboard: rows },
  });
}

/** 被网页指定的人：用户名是 Telegram 核实的，别人冒充不了，私聊就直接绑定，不用点按钮。 */
export async function claimIfDesignated(app: App, user: User, chatId: number): Promise<boolean> {
  if (app.settings.claimMode !== "user" || !firstClaimOpen(app, user)) return false;
  await becomeOwner(app, user, chatId);
  return true;
}

export type ClaimResult = "ok" | "wrong" | "closed";

export async function claimByButton(app: App, user: User, chatId: number, choice: string): Promise<ClaimResult> {
  if (!firstClaimOpen(app, user)) return "closed";
  // 先查是不是数字：Number("") 是 0，空的按钮数据会被当成第 0 个图案
  if (app.settings.claimMode === "pair" && (!/^\d+$/.test(choice) || CLAIM_PAIRS[Number(choice)] !== app.settings.claimPair)) {
    // 只关按钮，链接是服务器才有的秘密，仍然有效。否则别人故意点错就能把部署的人挡在外面
    await saveSetting(app.db, app.settings, "claimPair", "");
    app.log("warn", "绑定按钮已失效", `${displayName(user)} 点错了配对图案`);
    return "wrong";
  }
  await becomeOwner(app, user, chatId);
  return "ok";
}
