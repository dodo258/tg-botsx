// 管理面板的按钮动作和分步输入：不会打命令的人，所有管理操作都能点按钮完成。
import type { CallbackQuery, Message } from "@grammyjs/types";
import type { App } from "./app.ts";
import { isOwner } from "./app.ts";
import {
  cleanupPage,
  deliverQuick,
  exportToOwner,
  HELP,
  offerBroadcast,
  renderBlocked,
  renderFiltered,
  renderQuick,
  renderRules,
  searchContacts,
  statsText,
  statusText,
} from "./commands.ts";
import { getContact, identityHtml } from "./contacts.ts";
import { num, str } from "./db.ts";
import { backRow, CANCEL_KEYBOARD, clearAwaiting, currentAwaiting, handleAwaitingInput, renderMore, renderPanel, setAwaiting } from "./menus.ts";
import { clipChars, clipHtml, escapeHtml, kindLabel } from "./message-info.ts";
import { findById, resolveDeskMessage, toMessage } from "./messages.ts";
import { selectedUser, setSelected } from "./outbound.ts";
import { retract } from "./sync.ts";
import { TelegramError } from "./telegram.ts";

export interface Ctx {
  app: App;
  query: CallbackQuery;
  chatId: number;
  messageId: number;
  answer(text?: string, alert?: boolean): Promise<void>;
}

export async function edit(ctx: Ctx, html: string, keyboard?: unknown): Promise<void> {
  try {
    await ctx.app.tg.call("editMessageText", {
      chat_id: ctx.chatId,
      message_id: ctx.messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
    });
  } catch (error) {
    if (error instanceof TelegramError && error.notModified) return;
    throw error;
  }
}

function threadOf(ctx: Ctx): Record<string, number> {
  const thread = ctx.query.message?.message_thread_id;
  return thread === undefined ? {} : { message_thread_id: thread };
}

async function send(ctx: Ctx, html: string, keyboard?: unknown): Promise<void> {
  await ctx.app.tg.call("sendMessage", {
    chat_id: ctx.chatId,
    ...threadOf(ctx),
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
  });
}

/** 让管理员发一段文字。发的时候记下在等什么，下一条消息就当作输入。 */
async function ask(ctx: Ctx, what: string, prompt: string): Promise<void> {
  await setAwaiting(ctx.app, ctx.query.from.id, what, { chatId: ctx.chatId, threadId: ctx.query.message?.message_thread_id });
  await send(ctx, prompt, CANCEL_KEYBOARD);
}

function id(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const quickById = (app: App, rowId: number) => app.db.prepare("SELECT name, body FROM quick_replies WHERE rowid = ?").bind(rowId).first<{ name: unknown; body: unknown }>();

/** 只有主人能点的动作 */
export const PANEL_OWNER_ACTIONS = new Set(["rl", "rv", "rd", "ra", "bc", "bcx", "ex", "cl"]);
export const PANEL_ACTIONS = new Set(["p", "fblock", "unsel", "qm", "qv", "qd", "qa", "qp", "qs", "bk", "ubl", "srch", "undo", "undo!", "cancel", ...PANEL_OWNER_ACTIONS]);

export async function panelAction(ctx: Ctx, action: string, arg: string, extra: string | undefined): Promise<void> {
  const { app, query } = ctx;
  const owner = isOwner(app, query.from.id);
  switch (action) {
    case "p": {
      if (arg === "stats") return await edit(ctx, await statsText(app), { inline_keyboard: [backRow()] });
      if (arg === "help") return await edit(ctx, HELP, { inline_keyboard: [backRow()] });
      if (arg === "status") {
        if (!owner) return await ctx.answer("只有主人能操作。", true);
        return await edit(ctx, await statusText(app), { inline_keyboard: [backRow()] });
      }
      if (arg === "more") {
        if (!owner) return await ctx.answer("只有主人能操作。", true);
        const more = renderMore();
        return await edit(ctx, more.text, more.keyboard);
      }
      const panel = await renderPanel(app, owner, query.from.id);
      return await edit(ctx, panel.text, panel.keyboard);
    }
    case "fblock": {
      // 隔离区里屏蔽：留在隔离区这一页，不换成单人卡片的按钮
      const userId = id(arg);
      if (userId !== null) await app.db.prepare("UPDATE contacts SET blocked_at = ? WHERE user_id = ?").bind(app.now(), userId).run();
      await ctx.answer("已屏蔽");
      const page = await renderFiltered(app, 0);
      return await edit(ctx, page.text, page.keyboard);
    }
    case "unsel": {
      const userId = id(arg);
      if (userId !== null && (await selectedUser(app, query.from.id)) === userId) await setSelected(app, query.from.id, null);
      return await edit(ctx, "已取消选中。之后发的消息不会发给任何人，除非长按回复或重新选一个。", { inline_keyboard: [[{ text: "💬 最近会话", callback_data: "list:0" }], backRow()] });
    }
    case "cancel":
      // 等待状态在回调入口已经清掉了
      return await edit(ctx, "已取消。");

    // ---------- 快捷回复 ----------
    case "qm": {
      const page = await renderQuick(app, id(arg) ?? 0);
      return await edit(ctx, page.text, page.keyboard);
    }
    case "qv": {
      const rowId = id(arg);
      const quick = rowId === null ? null : await quickById(app, rowId);
      if (!quick) return await ctx.answer("这条快捷回复已经没有了。", true);
      return await edit(ctx, `<b>${clipHtml(str(quick.name), 60)}</b>\n\n${clipHtml(str(quick.body), 3000)}`, {
        inline_keyboard: [[{ text: "🗑 删除", callback_data: `qd:${rowId}` }, { text: "⬅️ 返回", callback_data: "qm:0" }]],
      });
    }
    case "qd": {
      const rowId = id(arg);
      if (rowId !== null) await app.db.prepare("DELETE FROM quick_replies WHERE rowid = ?").bind(rowId).run();
      await ctx.answer("已删除");
      const page = await renderQuick(app, 0);
      return await edit(ctx, page.text, page.keyboard);
    }
    case "qa":
      return await ask(ctx, "p:qname", "给这条快捷回复起个名字，比如「价格」。");
    case "qp": {
      const userId = id(arg);
      const contact = userId === null ? null : await getContact(app, userId);
      if (!contact) return await ctx.answer("联系人不存在。", true);
      const rows = await app.db.prepare("SELECT rowid AS id, name FROM quick_replies ORDER BY name LIMIT 30").all<{ id: unknown; name: unknown }>();
      if (rows.length === 0) return await send(ctx, "还没有快捷回复，先添加一条。", { inline_keyboard: [[{ text: "➕ 添加快捷回复", callback_data: "qa" }]] });
      const buttons = rows.map((row) => [{ text: clipChars(str(row.name), 40), callback_data: `qs:${contact.userId}:${num(row.id)}` }]);
      return await send(ctx, `选一条发给 ${identityHtml(contact)}：`, { inline_keyboard: [...buttons, [{ text: "❌ 取消", callback_data: "dismiss" }]] });
    }
    case "qs": {
      const userId = id(arg);
      const rowId = id(extra);
      const contact = userId === null ? null : await getContact(app, userId);
      const quick = rowId === null ? null : await quickById(app, rowId);
      if (!contact || !quick) return await ctx.answer("联系人或快捷回复已经没有了。", true);
      // 按钮连点时不重复发：更新是一条条处理的，第一次处理完记录已经在了
      const recent = await app.db.prepare("SELECT id FROM messages WHERE user_id = ? AND direction = 'out' AND text = ? AND created_at >= ? LIMIT 1").bind(contact.userId, str(quick.body), app.now() - 5).first();
      if (recent) return await ctx.answer("刚发过了。");
      const failure = await deliverQuick(app, contact, str(quick.body), ctx.chatId, query.message?.message_thread_id, query.from.id);
      return await edit(ctx, failure ?? `已发给 ${identityHtml(contact)}。`);
    }

    // ---------- 关键词自动回复 ----------
    case "rl": {
      const page = await renderRules(app, id(arg) ?? 0);
      return await edit(ctx, page.text, page.keyboard);
    }
    case "rv": {
      const ruleId = id(arg);
      const rule = ruleId === null ? null : await app.db.prepare("SELECT * FROM auto_rules WHERE id = ?").bind(ruleId).first();
      if (!rule) return await ctx.answer("这条规则已经没有了。", true);
      return await edit(ctx, `<b>关键词</b>：${clipHtml(str(rule.keywords), 500)}\n<b>自动回复</b>：${clipHtml(str(rule.reply), 2500)}\n命中 ${num(rule.hits)} 次`, {
        inline_keyboard: [[{ text: "🗑 删除", callback_data: `rd:${ruleId}` }, { text: "⬅️ 返回", callback_data: "rl:0" }]],
      });
    }
    case "rd": {
      const ruleId = id(arg);
      if (ruleId !== null) await app.db.prepare("DELETE FROM auto_rules WHERE id = ?").bind(ruleId).run();
      await ctx.answer("已删除");
      const page = await renderRules(app, 0);
      return await edit(ctx, page.text, page.keyboard);
    }
    case "ra":
      return await ask(ctx, "p:rkeys", "别人的消息里出现哪些词时自动回复？多个词用逗号分开，比如：价格,多少钱");

    // ---------- 联系人 ----------
    case "srch":
      return await ask(ctx, "p:search", "发来要找的名字、用户名、备注或数字 ID。");
    case "bk": {
      const page = await renderBlocked(app, id(arg) ?? 0);
      return await edit(ctx, page.text, page.keyboard);
    }
    case "ubl": {
      const userId = id(arg);
      if (userId !== null) await app.db.prepare("UPDATE contacts SET blocked_at = NULL, block_reason = '' WHERE user_id = ?").bind(userId).run();
      await ctx.answer("已解除屏蔽");
      const page = await renderBlocked(app, 0);
      return await edit(ctx, page.text, page.keyboard);
    }
    case "undo": {
      const userId = id(arg);
      const row = userId === null ? null : await app.db.prepare("SELECT * FROM messages WHERE user_id = ? AND direction = 'out' AND user_msg_id IS NOT NULL AND retracted_at IS NULL ORDER BY id DESC LIMIT 1").bind(userId).first();
      if (!row) return await ctx.answer("没有可以撤回的消息。", true);
      const last = toMessage(row);
      return await send(ctx, `撤回发给对方的最后一条消息？\n\n${clipHtml(last.text ?? `[${kindLabel(last.kind)}]`, 800)}`, {
        inline_keyboard: [[{ text: "↩️ 确认撤回", callback_data: `undo!:${last.id}` }, { text: "❌ 取消", callback_data: "dismiss" }]],
      });
    }
    case "undo!": {
      const messageId = id(arg);
      const stored = messageId === null ? null : await findById(app, messageId);
      if (!stored) return await ctx.answer("这条消息已经没有记录了。", true);
      return await edit(ctx, escapeHtml(await retract(app, stored)));
    }

    // ---------- 主人 ----------
    case "bc": {
      const running = await app.db.prepare("SELECT id FROM broadcasts WHERE state = 'running' LIMIT 1").first();
      if (running) return await edit(ctx, "上一次群发还没结束。", { inline_keyboard: [[{ text: "🛑 取消这次群发", callback_data: "bcx" }], backRow()] });
      return await ask(ctx, "p:broadcast", "把要群发的内容发给我，文字、图片、文件都可以，一次一条。发完会先问你确认，不会马上发出去。");
    }
    case "bcx": {
      const changed = await app.db.prepare("UPDATE broadcasts SET state = 'cancelled', finished_at = ? WHERE state IN ('draft','running')").bind(app.now()).run();
      return await edit(ctx, changed ? "群发已取消。" : "没有进行中的群发。", { inline_keyboard: [backRow()] });
    }
    case "ex":
      await exportToOwner(app);
      return await ctx.answer("已发到你和机器人的私聊。");
    case "cl": {
      const page = await cleanupPage(app);
      return await edit(ctx, page.text, page.keyboard);
    }
    default:
      return;
  }
}

/** 管理员的下一条消息如果是在回答按钮的提问，在这里处理。返回 true 表示已处理。 */
export async function handleInput(app: App, message: Message, staffId: number): Promise<boolean> {
  // 明确回复了某个客户的消息，就是在回复客户，不管刚才点过什么。否则这句话会变成欢迎语或备注
  const reply = message.reply_to_message;
  if (reply && !Object.hasOwn(reply, "forum_topic_created") && (await resolveDeskMessage(app, message.chat.id, reply.message_id))) {
    await clearAwaiting(app, staffId, message.chat.id);
    return false;
  }
  const awaiting = await currentAwaiting(app, staffId, message);
  if (!awaiting?.startsWith("p:")) return await handleAwaitingInput(app, message, staffId);
  const scope = { chatId: message.chat.id, threadId: message.message_thread_id };
  const text = message.text ?? "";
  const thread = message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id };
  const answer = (body: string, keyboard?: unknown) =>
    app.tg.call("sendMessage", { chat_id: message.chat.id, ...thread, text: body, ...(keyboard === undefined ? {} : { reply_markup: keyboard }) });
  if (text === "/cancel") {
    await clearAwaiting(app, staffId, message.chat.id);
    await answer("已取消。");
    return true;
  }
  if (text.startsWith("/")) {
    await clearAwaiting(app, staffId, message.chat.id);
    return false;
  }
  if (awaiting === "p:broadcast") {
    await clearAwaiting(app, staffId, message.chat.id);
    await offerBroadcast(app, message, message.message_id);
    return true;
  }
  if (!text.trim()) {
    await answer("这里要发文字。", CANCEL_KEYBOARD);
    return true;
  }
  if (awaiting === "p:search") {
    await clearAwaiting(app, staffId, message.chat.id);
    await searchContacts(app, message, text.trim());
    return true;
  }
  if (awaiting === "p:qname") {
    const name = text.trim();
    if (name.length > 60) {
      await answer("名字太长了，控制在 60 字以内。", CANCEL_KEYBOARD);
      return true;
    }
    await setAwaiting(app, staffId, `p:qbody:${name}`, scope);
    await answer(`「${name}」要发什么内容？`, CANCEL_KEYBOARD);
    return true;
  }
  if (awaiting.startsWith("p:qbody:")) {
    if (text.length > 2000) {
      await answer("太长了，请控制在 2000 字以内。", CANCEL_KEYBOARD);
      return true;
    }
    await app.db
      .prepare("INSERT INTO quick_replies(name, body, updated_at) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
      .bind(awaiting.slice("p:qbody:".length), text, app.now())
      .run();
    await clearAwaiting(app, staffId, message.chat.id);
    await answer("已保存。", { inline_keyboard: [[{ text: "⚡️ 返回快捷回复", callback_data: "qm:0" }]] });
    return true;
  }
  if (awaiting === "p:rkeys") {
    if (text.length > 500) {
      await answer("关键词太长了，控制在 500 字以内。", CANCEL_KEYBOARD);
      return true;
    }
    await setAwaiting(app, staffId, `p:rbody:${text.trim()}`, scope);
    await answer("出现这些词时自动回复什么？", CANCEL_KEYBOARD);
    return true;
  }
  if (awaiting.startsWith("p:rbody:")) {
    if (text.length > 2000) {
      await answer("太长了，请控制在 2000 字以内。", CANCEL_KEYBOARD);
      return true;
    }
    await app.db.prepare("INSERT INTO auto_rules(keywords, reply, created_at) VALUES(?, ?, ?)").bind(awaiting.slice("p:rbody:".length), text, app.now()).run();
    await clearAwaiting(app, staffId, message.chat.id);
    await answer("已添加。", { inline_keyboard: [[{ text: "🤖 返回关键词回复", callback_data: "rl:0" }]] });
    return true;
  }
  await clearAwaiting(app, staffId, message.chat.id);
  return false;
}
