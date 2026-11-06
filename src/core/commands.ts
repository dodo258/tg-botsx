// 管理员命令。在私聊和绑定的话题群里都能用；改配置、群发、导出这类只有主人能用。
import type { Message } from "@grammyjs/types";
import type { App } from "./app.ts";
import { isOwner } from "./app.ts";
import type { Contact } from "./contacts.ts";
import { dayKey, formatTime, fullName, getContact, identityHtml, toContact } from "./contacts.ts";
import { num, str } from "./db.ts";
import { cardText, contactKeyboard, usesThreads } from "./desk.ts";
import { backRow, CANCEL_KEYBOARD, deskModeLabel, renderMenu, renderPanel, setAwaiting } from "./menus.ts";
import { clipChars, clipHtml, escapeHtml, fitLines, kindLabel } from "./message-info.ts";
import { toMessage } from "./messages.ts";
import { failureText, markUnreachable, recordOutbound, routeOf } from "./outbound.ts";
import { fetchBot, syncCommands } from "./setup.ts";
import { saveSetting } from "./settings.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { retract } from "./sync.ts";
import { TelegramError } from "./telegram.ts";

export const VERSION = "0.1.0";

/** 群里发给别的机器人的命令，比如 /start@other_bot。 */
export function isOtherBotCommand(text: string | undefined, botUsername: string): boolean {
  const target = /^\/[a-zA-Z_]+@(\w+)(?:\s|$)/.exec(text ?? "")?.[1];
  return target !== undefined && botUsername !== "" && target.toLowerCase() !== botUsername.toLowerCase();
}

export function parseCommand(text: string | undefined, botUsername: string): { name: string; args: string } | null {
  const match = /^\/([a-zA-Z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text ?? "");
  if (!match) return null;
  const target = match[2];
  // 群里 @别的机器人 的命令不归我们管
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: (match[3] ?? "").trim() };
}

export const HELP =
  "<b>❓ 怎么回复别人</b>\n\n" +
  "<b>1. 长按回复</b>\n长按对方转来的消息，点「回复」，写完发送。再久以前的消息也可以。\n\n" +
  "<b>2. 消息被顶上去了，找不到</b>\n点菜单打开面板 → 「最近会话」（有未读的排在前面），或者「搜索联系人」按名字、@用户名找。点名字，再点「✍️ 选中，直接回复」，之后直接打字就是发给他。首页最上面会一直显示正在回复谁。\n\n" +
  "话题群模式下，直接在对方的话题里发。\n\n" +
  "发出去后你的消息上会出现 👌，对方看不到你的账号。以 // 开头的话留在这里，不会发给对方。\n\n" +
  "<b>习惯打字的话</b>\n" +
  "/list 最近会话，/search 关键词，/history 聊天记录，/note 备注\n/block /unblock 屏蔽和解除，/del 回复自己的消息撤回\n/q 快捷回复，/qadd 名字 内容，/qdel 名字，/filtered 隔离区，/stats 统计\n" +
  "只有主人能用：/settings /rule /broadcast /bindgroup /status /cleanup /export\n" +
  "命令后面可以跟联系人数字 ID，比如 /history 123456。";

const PAGE = 8;

async function say(app: App, message: Message, html: string, keyboard?: unknown): Promise<void> {
  await app.tg.call("sendMessage", {
    chat_id: message.chat.id,
    ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
  });
}

function parseUserId(value: string): number | null {
  const id = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 命令的目标联系人：参数里的 ID 优先，其次当前上下文。 */
async function targetContact(app: App, message: Message, staffId: number, arg: string): Promise<Contact | null> {
  const id = parseUserId(arg.split(/\s+/)[0] ?? "");
  if (id !== null) return await getContact(app, id);
  const route = await routeOf(app, message, staffId);
  return route?.contact ?? null;
}

export async function renderSessions(app: App, offset: number): Promise<{ text: string; keyboard: unknown }> {
  const rows = await app.db.prepare("SELECT * FROM contacts ORDER BY unread > 0 DESC, last_seen DESC LIMIT ? OFFSET ?").bind(PAGE + 1, offset).all();
  const contacts = rows.slice(0, PAGE).map(toContact);
  if (contacts.length === 0) return { text: offset === 0 ? "还没有人联系过。把机器人链接发出去试试。" : "没有更多了。", keyboard: { inline_keyboard: [backRow()] } };
  const lines = contacts.map((contact) => {
    const unread = contact.unread > 0 ? `<b>未读 ${contact.unread}</b> · ` : "";
    const blocked = contact.blockedAt === null ? "" : "已屏蔽 · ";
    return `${identityHtml(contact)}\n${blocked}${unread}${formatTime(contact.lastSeen, app.settings.timezone)}`;
  });
  const buttons = contacts.map((contact) => [{ text: clipChars(`${contact.unread > 0 ? `(${contact.unread}) ` : ""}${fullName(contact)}`, 40), callback_data: `open:${contact.userId}` }]);
  const nav = [];
  if (offset > 0) nav.push({ text: "⬅️ 上一页", callback_data: `list:${Math.max(0, offset - PAGE)}` });
  if (rows.length > PAGE) nav.push({ text: "➡️ 下一页", callback_data: `list:${offset + PAGE}` });
  if (nav.length > 0) buttons.push(nav);
  buttons.push(backRow());
  return { text: `<b>💬 最近会话</b>\n有未读的排在前面。点名字就能回复他。\n\n${lines.join("\n\n")}`, keyboard: { inline_keyboard: buttons } };
}

export async function renderHistory(app: App, userId: number, offset: number): Promise<{ text: string; keyboard: unknown }> {
  const contact = await getContact(app, userId);
  const rows = await app.db.prepare("SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?").bind(userId, PAGE + 1, offset).all();
  const shown = rows.slice(0, PAGE).map(toMessage).reverse();
  const title = contact ? identityHtml(contact) : String(userId);
  if (shown.length === 0) return { text: `${title}\n\n没有记录。`, keyboard: undefined };
  const lines = shown.map((row) => {
    const who = row.direction === "in" ? "对方" : "我方";
    const flags = [row.retractedAt !== null ? "已撤回" : "", row.status === "filtered" ? `隔离：${row.reason ?? ""}` : "", row.status === "failed" ? "待补发" : ""].filter(Boolean).join("，");
    const body = row.text ?? (row.fileId || row.kind !== "text" ? `[${kindLabel(row.kind)}]` : "[内容已清理]");
    return `<code>${formatTime(row.createdAt, app.settings.timezone)}</code> <b>${who}</b>${flags ? `（${clipHtml(flags, 200)}）` : ""}\n${clipHtml(body, 800)}`;
  });
  // 最新的最重要：放不下时丢最早的
  const kept = fitLines([...lines].reverse(), "\n\n").kept.reverse().join("\n\n");
  const buttons = [];
  if (rows.length > PAGE) buttons.push({ text: "⬅️ 更早", callback_data: `history:${userId}:${offset + PAGE}` });
  if (offset > 0) buttons.push({ text: "➡️ 更新", callback_data: `history:${userId}:${Math.max(0, offset - PAGE)}` });
  return { text: `${title}\n\n${kept}`, keyboard: buttons.length ? { inline_keyboard: [buttons] } : undefined };
}

export async function renderFiltered(app: App, offset: number): Promise<{ text: string; keyboard: unknown }> {
  const rows = await app.db.prepare("SELECT * FROM messages WHERE status = 'filtered' ORDER BY id DESC LIMIT ? OFFSET ?").bind(PAGE + 1, offset).all();
  const shown = rows.slice(0, PAGE).map(toMessage);
  if (shown.length === 0) return { text: offset === 0 ? "隔离区是空的。" : "没有更多了。", keyboard: { inline_keyboard: [backRow()] } };
  const lines = shown.map((row, index) => `${index + 1}. <code>${row.userId}</code> · ${formatTime(row.createdAt, app.settings.timezone)} · ${clipHtml(row.reason ?? "", 120)}\n${clipHtml(row.text ?? `[${kindLabel(row.kind)}]`, 300)}`);
  const buttons = shown.map((row, index) => [
    { text: `✅ 放行 ${index + 1}`, callback_data: `release:${row.id}` },
    { text: `🚫 屏蔽 ${index + 1}`, callback_data: `fblock:${row.userId}` },
  ]);
  if (rows.length > PAGE) buttons.push([{ text: "➡️ 下一页", callback_data: `filtered:${offset + PAGE}` }]);
  buttons.push(backRow());
  return { text: `<b>🛡 隔离区</b>\n\n${fitLines(lines, "\n\n").text}`, keyboard: { inline_keyboard: buttons } };
}

type Page = { text: string; keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } };

function pagerRow(action: string, offset: number, more: boolean): { text: string; callback_data: string }[] {
  return [
    ...(offset > 0 ? [{ text: "⬅️ 上一页", callback_data: `${action}:${Math.max(0, offset - PAGE)}` }] : []),
    ...(more ? [{ text: "➡️ 下一页", callback_data: `${action}:${offset + PAGE}` }] : []),
  ];
}

export async function renderBlocked(app: App, offset: number): Promise<Page> {
  const rows = await app.db.prepare("SELECT * FROM contacts WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC LIMIT ? OFFSET ?").bind(PAGE + 1, offset).all();
  const shown = rows.slice(0, PAGE).map(toContact);
  if (shown.length === 0) return { text: "没有屏蔽任何人。", keyboard: { inline_keyboard: [backRow()] } };
  const buttons = shown.map((contact) => [{ text: clipChars(`✅ 解除屏蔽：${fullName(contact)}`, 40), callback_data: `ubl:${contact.userId}` }]);
  const pager = pagerRow("bk", offset, rows.length > PAGE);
  return { text: `<b>🚫 已屏蔽</b>\n\n${shown.map(identityHtml).join("\n")}`, keyboard: { inline_keyboard: [...buttons, ...(pager.length ? [pager] : []), backRow()] } };
}

export async function renderQuick(app: App, offset: number): Promise<Page> {
  const rows = await app.db.prepare("SELECT rowid AS id, name, body FROM quick_replies ORDER BY name LIMIT ? OFFSET ?").bind(PAGE + 1, offset).all<{ id: unknown; name: unknown; body: unknown }>();
  const shown = rows.slice(0, PAGE);
  const buttons = shown.map((row) => [{ text: clipChars(str(row.name), 40), callback_data: `qv:${num(row.id)}` }]);
  const pager = pagerRow("qm", offset, rows.length > PAGE);
  const list = fitLines(shown.map((row) => `<b>${clipHtml(str(row.name), 60)}</b>：${clipHtml(str(row.body), 80)}`), "\n").text;
  return {
    text: shown.length ? `<b>⚡️ 快捷回复</b>\n点名字查看或删除。要发给别人，点联系人卡片上的「快捷回复」。\n\n${list}` : "<b>⚡️ 快捷回复</b>\n还没有。添加常用的话，回复时点一下就能发。",
    keyboard: { inline_keyboard: [...buttons, ...(pager.length ? [pager] : []), [{ text: "➕ 添加", callback_data: "qa" }], backRow()] },
  };
}

export async function renderRules(app: App, offset: number): Promise<Page> {
  const rows = await app.db.prepare("SELECT * FROM auto_rules ORDER BY id LIMIT ? OFFSET ?").bind(PAGE + 1, offset).all();
  const shown = rows.slice(0, PAGE);
  const buttons = shown.map((row) => [{ text: clipChars(str(row.keywords), 40), callback_data: `rv:${num(row.id)}` }]);
  const pager = pagerRow("rl", offset, rows.length > PAGE);
  const list = fitLines(shown.map((row) => `${num(row.id)}. ${clipHtml(str(row.keywords), 80)} → ${clipHtml(str(row.reply), 60)}（命中 ${num(row.hits)}）`), "\n", 3500).text;
  return {
    text: `<b>🤖 关键词自动回复</b>\n别人的消息里出现这些词时，机器人自动回复。\n\n${shown.length ? list : "还没有。"}`,
    keyboard: { inline_keyboard: [...buttons, ...(pager.length ? [pager] : []), [{ text: "➕ 添加", callback_data: "ra" }], backRow()] },
  };
}

export async function cleanupPage(app: App): Promise<Page> {
  const total = await app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text IS NOT NULL OR file_id IS NOT NULL").first<{ n: unknown }>();
  return {
    text: `现在有 ${num(total?.n)} 条带内容的记录。要清理多久以前的？\n只抹内容，联系人和回复关系都保留。`,
    keyboard: {
      inline_keyboard: [
        [{ text: "30 天前", callback_data: "clean?:30" }, { text: "90 天前", callback_data: "clean?:90" }, { text: "180 天前", callback_data: "clean?:180" }],
        [{ text: "🧹 全部", callback_data: "clean?:0" }, { text: "🏠 返回首页", callback_data: "p:main" }],
      ],
    },
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

export async function statsText(app: App): Promise<string> {
  const today = dayKey(app.now(), app.settings.timezone);
  const weekAgo = dayKey(app.now() - 6 * 86_400, app.settings.timezone);
  const [todayRow, weekRow, totals] = await Promise.all([
    app.db.prepare("SELECT * FROM daily_stats WHERE day = ?").bind(today).first(),
    app.db.prepare("SELECT SUM(inbound) AS inbound, SUM(outbound) AS outbound, SUM(new_contacts) AS new_contacts, SUM(filtered) AS filtered, SUM(reply_seconds) AS reply_seconds, SUM(replies) AS replies FROM daily_stats WHERE day >= ?").bind(weekAgo).first(),
    app.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN unread > 0 THEN 1 ELSE 0 END) AS unread, SUM(CASE WHEN blocked_at IS NOT NULL THEN 1 ELSE 0 END) AS blocked FROM contacts").first(),
  ]);
  const line = (row: Record<string, unknown> | null) => {
    const replies = num(row?.replies);
    const speed = replies > 0 ? formatDuration(num(row?.reply_seconds) / replies) : "暂无";
    return `收到 ${num(row?.inbound)} · 回复 ${num(row?.outbound)} · 新联系人 ${num(row?.new_contacts)} · 拦截 ${num(row?.filtered)}\n平均首次回复：${speed}`;
  };
  return `<b>今天</b>\n${line(todayRow)}\n\n<b>近 7 天</b>\n${line(weekRow)}\n\n<b>总计</b>\n联系人 ${num(totals?.total)} · 有未读 ${num(totals?.unread)} · 已屏蔽 ${num(totals?.blocked)}`;
}

export async function statusText(app: App): Promise<string> {
  const lines = [`<b>运行状态</b>`, `版本 ${VERSION} · 数据库结构 v${SCHEMA_VERSION}`, `消息收在：${deskModeLabel(app.settings)}`];
  if (app.settings.floodUntil > app.now()) lines.push(`防轰炸中，到 ${formatTime(app.settings.floodUntil, app.settings.timezone)}`);
  const failed = await app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed' AND direction = 'in'").first<{ n: unknown }>();
  lines.push(`待补发消息：${num(failed?.n)}`);
  return lines.join("\n");
}

/** 把快捷回复发给联系人，并在客服台留一份。失败时返回给管理员看的原因。 */
export async function deliverQuick(app: App, contact: Contact, body: string, chatId: number, threadId: number | undefined, staffId: number): Promise<string | null> {
  let sent: { message_id: number };
  try {
    sent = await app.tg.call<{ message_id: number }>("sendMessage", { chat_id: contact.userId, text: body });
  } catch (error) {
    if (error instanceof TelegramError && error.userUnreachable) await markUnreachable(app, contact);
    return failureText(contact, error);
  }
  // 对方已经收到了。留底失败不能说「没发出去」，否则管理员会再发一遍
  let shownId = 0;
  try {
    const shown = await app.tg.call<{ message_id: number }>("sendMessage", { chat_id: chatId, ...(threadId === undefined ? {} : { message_thread_id: threadId }), text: body });
    shownId = shown.message_id;
  } catch (error) {
    app.log("warn", "快捷回复留底失败", error instanceof Error ? error.message : String(error));
  }
  await recordOutbound(app, contact, { kind: "text", text: body, fileId: "", userMsgId: sent.message_id, deskChatId: chatId, deskMsgId: shownId, staffId });
  return null;
}

async function cmdQuick(app: App, message: Message, staffId: number, args: string): Promise<void> {
  if (!args) {
    const page = await renderQuick(app, 0);
    await say(app, message, page.text, page.keyboard);
    return;
  }
  const quick = await app.db.prepare("SELECT body FROM quick_replies WHERE name = ?").bind(args).first<{ body: unknown }>();
  if (!quick) {
    await say(app, message, `没有叫「${escapeHtml(args)}」的快捷回复。`);
    return;
  }
  const route = await routeOf(app, message, staffId);
  if (!route) {
    await say(app, message, "不知道要发给谁。在话题里发，或回复对方的消息，或先选中会话。");
    return;
  }
  const failure = await deliverQuick(app, route.contact, str(quick.body), message.chat.id, message.message_thread_id, staffId);
  if (failure) await say(app, message, failure);
}

async function cmdRule(app: App, message: Message, args: string): Promise<void> {
  const [sub, ...rest] = args.split(/\s+/);
  if (sub === "add") {
    const parts = args.slice(3).split("|");
    const keywords = parts[0]?.trim() ?? "";
    const reply = parts.slice(1).join("|").trim();
    if (!keywords || !reply) {
      await say(app, message, "用法：/rule add 价格,多少钱 | 价格表在这里：…");
      return;
    }
    await app.db.prepare("INSERT INTO auto_rules(keywords, reply, created_at) VALUES(?, ?, ?)").bind(keywords, reply, app.now()).run();
    await say(app, message, "已添加。");
    return;
  }
  if (sub === "del") {
    const id = Number(rest[0]);
    const changed = Number.isInteger(id) ? await app.db.prepare("DELETE FROM auto_rules WHERE id = ?").bind(id).run() : 0;
    await say(app, message, changed ? "已删除。" : "没有这条规则。");
    return;
  }
  const page = await renderRules(app, 0);
  await say(app, message, page.text, page.keyboard);
}

async function cmdBroadcast(app: App, message: Message, args: string): Promise<void> {
  if (args === "cancel") {
    const changed = await app.db.prepare("UPDATE broadcasts SET state = 'cancelled', finished_at = ? WHERE state IN ('draft','running')").bind(app.now()).run();
    await say(app, message, changed ? "群发已取消。" : "没有进行中的群发。");
    return;
  }
  const source = message.reply_to_message;
  // 话题里不引用也带 reply_to_message，指向话题创建消息，不能当群发内容
  if (!source || Object.hasOwn(source, "forum_topic_created")) {
    await say(app, message, "先写好要群发的内容，然后回复那条消息发 /broadcast。也可以在面板里点「群发」。");
    return;
  }
  await offerBroadcast(app, message, source.message_id);
}

/** 问主人要不要群发这条消息。确认按钮按下去才真的发。 */
export async function offerBroadcast(app: App, message: Message, sourceId: number): Promise<void> {
  const running = await app.db.prepare("SELECT id FROM broadcasts WHERE state = 'running' LIMIT 1").first();
  if (running) {
    await say(app, message, "上一次群发还没结束。", { inline_keyboard: [[{ text: "🛑 取消这次群发", callback_data: "bcx" }]] });
    return;
  }
  const count = await app.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE blocked_at IS NULL AND unreachable_at IS NULL AND msg_count > 0").first<{ n: unknown }>();
  const total = num(count?.n);
  const row = await app.db
    .prepare("INSERT INTO broadcasts(from_chat_id, from_msg_id, report_chat_id, total, created_at) VALUES(?, ?, ?, ?, ?) RETURNING id")
    .bind(message.chat.id, sourceId, message.chat.id, total, app.now())
    .first<{ id: unknown }>();
  await say(app, message, `要把这条消息发给 ${total} 个联系人吗？已屏蔽和不可达的不发。`, {
    inline_keyboard: [[{ text: `✅ 确认发给 ${total} 人`, callback_data: `bc_go:${num(row?.id)}` }, { text: "❌ 取消", callback_data: `bc_no:${num(row?.id)}` }]],
  });
}

export async function exportToOwner(app: App): Promise<void> {
  const contacts = await app.db.prepare("SELECT * FROM contacts ORDER BY user_id").all();
  const messages = await app.db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 20000").all();
  const data = JSON.stringify({ exportedAt: app.now(), version: VERSION, contacts, messages }, null, 1);
  // 导出含全部聊天内容，只发给主人本人，在群里发命令也不能发到群里
  const ownerId = app.settings.ownerId;
  if (ownerId === null) return;
  await app.tg.upload(
    "sendDocument",
    {
      chat_id: ownerId,
      caption: `联系人 ${contacts.length} 个，消息 ${messages.length} 条（最多导出最近 20000 条）。文件含聊天内容，注意保管。`,
    },
    "document",
    new TextEncoder().encode(data),
    `传声筒导出-${dayKey(app.now(), app.settings.timezone)}.json`,
    "application/json",
  );
}

export async function searchContacts(app: App, message: Message, query: string): Promise<void> {
  const pattern = `%${query.replace(/^@/, "").replace(/[%_]/g, "")}%`;
  const rows = await app.db
    .prepare("SELECT * FROM contacts WHERE CAST(user_id AS TEXT) = ? OR username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR note LIKE ? ORDER BY last_seen DESC LIMIT 8")
    .bind(query, pattern, pattern, pattern, pattern)
    .all();
  if (rows.length === 0) {
    await say(app, message, "没找到。", { inline_keyboard: [[{ text: "🔍 再搜一次", callback_data: "srch" }], backRow()] });
    return;
  }
  for (const row of rows) await sendContactCard(app, message, toContact(row));
}

/** 在群里绑定话题群。逐项检查并说清哪一步不对：匿名身份、没开话题、机器人没权限，是部署时最常见的三个坑。 */
export async function cmdBindGroup(app: App, message: Message): Promise<void> {
  if (message.chat.type === "private") {
    await say(app, message, "请到你要绑定的话题群里发这个命令。");
    return;
  }
  if (message.from?.is_bot || message.sender_chat) {
    await say(app, message, "你现在是匿名管理员，机器人认不出你。\n到群设置把自己的「匿名」关掉，再发一次 /bindgroup，绑定后可以再打开。");
    return;
  }
  if (!isOwner(app, message.from?.id)) {
    await say(app, message, "只有机器人的主人能绑定。");
    return;
  }
  const chat = await app.tg.call<{ is_forum?: boolean }>("getChat", { chat_id: message.chat.id });
  if (message.chat.type !== "supergroup" || !chat.is_forum) {
    await say(app, message, "这个群还没开话题。到群设置打开「话题」（Topics），再发一次 /bindgroup。");
    return;
  }
  const bot = await fetchBot(app);
  const member = await app.tg.call<{ status: string; can_manage_topics?: boolean }>("getChatMember", { chat_id: message.chat.id, user_id: bot.id });
  if (member.status !== "administrator") {
    await say(app, message, "机器人还不是这个群的管理员。把它设为管理员，并给「管理话题」权限，再发一次 /bindgroup。");
    return;
  }
  if (!member.can_manage_topics) {
    await say(app, message, "机器人缺「管理话题」权限。到管理员设置里打开，再发一次 /bindgroup。");
    return;
  }
  // 重新绑定同一个群时话题还在，不清对应关系，否则老话题里发的话找不到人
  const sameGroup = app.settings.deskMode === "group" && app.settings.groupId === message.chat.id;
  await saveSetting(app.db, app.settings, "groupId", message.chat.id);
  await saveSetting(app.db, app.settings, "deskMode", "group");
  if (!sameGroup) await app.db.prepare("UPDATE contacts SET thread_id = NULL, thread_claim_at = NULL").run();
  await syncCommands(app);
  await say(app, message, "绑定成功。之后每个联系人会有自己的话题，群里的人都能在话题里回复。\n以 // 开头的话只留在群里，不会发给对方。");
}

export async function sendContactCard(app: App, message: Message, contact: Contact): Promise<void> {
  const sent = await app.tg.call<{ message_id: number }>("sendMessage", {
    chat_id: message.chat.id,
    ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
    text: cardText(app, contact),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: contactKeyboard(contact, false, usesThreads(app)),
  });
  // 记下卡片归属，回复这张卡片才能发给对的人
  await app.db.prepare("INSERT OR REPLACE INTO cards(chat_id, message_id, user_id, created_at) VALUES(?, ?, ?, ?)").bind(message.chat.id, sent.message_id, contact.userId, app.now()).run();
}

/** 处理一条命令。返回 false 表示不是我们认识的命令，由调用方决定怎么提示。 */
export async function handleCommand(app: App, message: Message, staffId: number, name: string, args: string): Promise<boolean> {
  const owner = isOwner(app, staffId);
  const ownerOnly = async () => {
    if (owner) return true;
    await say(app, message, "这个命令只有主人能用。");
    return false;
  };
  switch (name) {
    case "start":
    case "menu": {
      // 点「绑定话题群」按钮把机器人拉进群后，Telegram 会在群里发 /start bind
      if (args === "bind" && message.chat.type !== "private") {
        await cmdBindGroup(app, message);
        return true;
      }
      const panel = await renderPanel(app, owner, staffId);
      await say(app, message, panel.text, panel.keyboard);
      return true;
    }
    case "help":
      await say(app, message, HELP);
      return true;
    case "list":
    case "sessions": {
      const page = await renderSessions(app, 0);
      await say(app, message, page.text, page.keyboard);
      return true;
    }
    case "search": {
      if (!args) {
        await say(app, message, "用法：/search 名字、用户名或 ID");
        return true;
      }
      await searchContacts(app, message, args);
      return true;
    }
    case "history": {
      const contact = await targetContact(app, message, staffId, args);
      if (!contact) {
        await say(app, message, "用法：/history 用户ID，或在话题里、回复对方消息时发。");
        return true;
      }
      const page = await renderHistory(app, contact.userId, 0);
      await say(app, message, page.text, page.keyboard);
      return true;
    }
    case "select": {
      await say(app, message, "直接点卡片上的「选中」按钮，或用 /search 找到人后点。");
      return true;
    }
    case "note": {
      const id = parseUserId(args.split(/\s+/)[0] ?? "");
      const body = id === null ? args : args.split(/\s+/).slice(1).join(" ");
      const contact = await targetContact(app, message, staffId, id === null ? "" : String(id));
      if (!contact) {
        await say(app, message, "用法：在话题里或回复对方消息时发 /note 内容，或 /note 用户ID 内容。");
        return true;
      }
      if (!body) {
        await setAwaiting(app, staffId, `note:${contact.userId}`, { chatId: message.chat.id, threadId: message.message_thread_id });
        await say(app, message, `给 ${identityHtml(contact)} 写备注，发 0 清空。\n现在的备注：${escapeHtml(contact.note) || "无"}`, CANCEL_KEYBOARD);
        return true;
      }
      await app.db.prepare("UPDATE contacts SET note = ? WHERE user_id = ?").bind(body.slice(0, 500), contact.userId).run();
      await say(app, message, "备注已保存。");
      return true;
    }
    case "block":
    case "unblock": {
      const id = parseUserId(args);
      const contact = id !== null ? await getContact(app, id) : (await routeOf(app, message, staffId))?.contact ?? null;
      if (!contact) {
        await say(app, message, `用法：/${name} 用户ID，或在话题里、回复对方消息时发。`);
        return true;
      }
      const blocked = name === "block";
      await app.db.prepare("UPDATE contacts SET blocked_at = ?, block_reason = '' WHERE user_id = ?").bind(blocked ? app.now() : null, contact.userId).run();
      await say(app, message, `${blocked ? "已屏蔽" : "已解除屏蔽"}：${identityHtml(contact)}`);
      return true;
    }
    case "blocked": {
      const page = await renderBlocked(app, 0);
      await say(app, message, page.text, page.keyboard);
      return true;
    }
    case "del": {
      const source = message.reply_to_message;
      if (!source) {
        await say(app, message, "回复你发出去的那条消息，再发 /del。");
        return true;
      }
      const route = await routeOf(app, message, staffId);
      if (!route?.stored) {
        await say(app, message, "这条消息没有记录，撤回不了。");
        return true;
      }
      await say(app, message, await retract(app, route.stored));
      return true;
    }
    case "q":
      await cmdQuick(app, message, staffId, args);
      return true;
    case "qadd": {
      const space = args.search(/\s/);
      if (space <= 0) {
        await say(app, message, "用法：/qadd 名字 内容");
        return true;
      }
      await app.db
        .prepare("INSERT INTO quick_replies(name, body, updated_at) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
        .bind(args.slice(0, space), args.slice(space).trim(), app.now())
        .run();
      await say(app, message, "已保存。");
      return true;
    }
    case "qdel": {
      const changed = await app.db.prepare("DELETE FROM quick_replies WHERE name = ?").bind(args).run();
      await say(app, message, changed ? "已删除。" : "没有这个快捷回复。");
      return true;
    }
    case "filtered": {
      const page = await renderFiltered(app, 0);
      await say(app, message, page.text, page.keyboard);
      return true;
    }
    case "stats":
      await say(app, message, await statsText(app));
      return true;
    case "cancel":
      await say(app, message, "没有进行中的操作。");
      return true;
    case "settings": {
      if (!(await ownerOnly())) return true;
      const menu = renderMenu(app, "main");
      await say(app, message, menu.text, menu.keyboard);
      return true;
    }
    case "rule":
      if (await ownerOnly()) await cmdRule(app, message, args);
      return true;
    case "broadcast":
      if (await ownerOnly()) await cmdBroadcast(app, message, args);
      return true;
    case "status":
      if (await ownerOnly()) await say(app, message, await statusText(app));
      return true;
    case "export":
      if (await ownerOnly()) {
        await exportToOwner(app);
        if (message.chat.id !== app.settings.ownerId) await say(app, message, "已发到你和机器人的私聊。");
      }
      return true;
    case "cleanup":
      if (await ownerOnly()) {
        const page = await cleanupPage(app);
        await say(app, message, page.text, page.keyboard);
      }
      return true;
    case "bindgroup":
      await cmdBindGroup(app, message);
      return true;
    default:
      return false;
  }
}
