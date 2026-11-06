// 按钮回调。验证题的回调来自陌生人，其余只接受客服台里的管理员。
import type { CallbackQuery } from "@grammyjs/types";
import type { App } from "./app.ts";
import { isOwner } from "./app.ts";
import type { Contact } from "./contacts.ts";
import { getContact, identityHtml } from "./contacts.ts";
import { num } from "./db.ts";
import { cardText, contactKeyboard, copyToDesk, usesThreads } from "./desk.ts";
import { challengePending, releaseHeld, sendChallenge } from "./inbound.ts";
import { backRow, CANCEL_KEYBOARD, clearAwaiting, INPUTS, renderMenu, setAwaiting, TOGGLES } from "./menus.ts";
import { findById, toMessage } from "./messages.ts";
import type { StoredMessage } from "./messages.ts";
import { selectedUser, setSelected } from "./outbound.ts";
import type { Ctx } from "./panel.ts";
import { edit, PANEL_ACTIONS, PANEL_OWNER_ACTIONS, panelAction } from "./panel.ts";
import { renderFiltered, renderHistory, renderSessions } from "./commands.ts";
import { broadcastTick } from "./maintenance.ts";
import { claimByButton, fetchBot, syncCommands } from "./setup.ts";
import { saveSetting } from "./settings.ts";
import { TelegramError } from "./telegram.ts";

async function deleteQuietly(ctx: Ctx): Promise<void> {
  try {
    await ctx.app.tg.call("deleteMessage", { chat_id: ctx.chatId, message_id: ctx.messageId });
  } catch (error) {
    ctx.app.log("warn", "删除消息失败", error instanceof Error ? error.message : String(error));
  }
}

function positiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// ---------- 验证 ----------

async function onVerify(ctx: Ctx, challengeId: string, token: string): Promise<void> {
  const { app, query } = ctx;
  const contact = await getContact(app, query.from.id);
  if (!contact) return ctx.answer();
  if (contact.lockedUntil !== null && contact.lockedUntil > app.now()) return ctx.answer("错太多次了，请过一会儿再试。", true);
  // 点到旧题不是错误：换题或连点都可能发生，不能因此锁人
  if (contact.challengeId !== challengeId) {
    await ctx.answer("这道题已经换掉了，请看最新的那道。");
    await deleteQuietly(ctx);
    return;
  }
  if (!challengePending(app, contact)) {
    await ctx.answer("超时了，换一道。");
    await deleteQuietly(ctx);
    await sendChallenge(app, contact);
    return;
  }
  if (token === contact.challengeToken) return await passVerification(ctx, contact);
  const failures = contact.failedAttempts + 1;
  if (failures >= app.settings.maxVerifyFailures) {
    const until = app.now() + app.settings.lockMinutes * 60;
    await app.db
      .prepare("UPDATE contacts SET failed_attempts = 0, locked_until = ?, challenge_id = NULL, challenge_token = NULL, challenge_at = NULL WHERE user_id = ?")
      .bind(until, contact.userId)
      .run();
    await ctx.answer(`错太多次了，请 ${app.settings.lockMinutes} 分钟后再试。`, true);
    await deleteQuietly(ctx);
    return;
  }
  await app.db.prepare("UPDATE contacts SET failed_attempts = ? WHERE user_id = ?").bind(failures, contact.userId).run();
  await ctx.answer("不对，再试一次。");
  await deleteQuietly(ctx);
  await sendChallenge(app, contact, `答错了，还有 ${app.settings.maxVerifyFailures - failures} 次机会。`);
}

async function passVerification(ctx: Ctx, contact: Contact): Promise<void> {
  const { app } = ctx;
  await app.db
    .prepare("UPDATE contacts SET verified_at = ?, failed_attempts = 0, locked_until = NULL, challenge_id = NULL, challenge_token = NULL, challenge_at = NULL WHERE user_id = ?")
    .bind(app.now(), contact.userId)
    .run();
  contact.verifiedAt = app.now();
  await ctx.answer("验证通过");
  const held = await app.db.prepare("SELECT COUNT(*) AS n FROM held_messages WHERE user_id = ?").bind(contact.userId).first<{ n: unknown }>();
  await edit(ctx, num(held?.n) > 0 ? "验证通过，刚才的消息已经转过去了。" : "验证通过，现在可以直接发消息了。");
  await releaseHeld(app, contact);
}

// ---------- 隔离区 ----------

async function releaseOne(app: App, stored: StoredMessage, contact: Contact): Promise<void> {
  if (stored.userMsgId === null) return;
  const copied = await copyToDesk(app, contact, { message_id: stored.userMsgId }, null);
  await app.db.batch([
    app.db.prepare("UPDATE messages SET status = 'sent', reason = NULL, desk_chat_id = ?, desk_msg_id = ? WHERE id = ?").bind(copied.chatId, copied.deskMsgId, stored.id),
    app.db.prepare("UPDATE contacts SET msg_count = msg_count + 1, unread = unread + 1, first_unread_at = COALESCE(first_unread_at, ?), approved_at = COALESCE(approved_at, ?) WHERE user_id = ?").bind(app.now(), app.now(), contact.userId),
  ]);
}

// ---------- 管理员操作 ----------

async function refreshCard(ctx: Ctx, userId: number): Promise<void> {
  const contact = await getContact(ctx.app, userId);
  if (!contact) return;
  const selected = (await selectedUser(ctx.app, ctx.query.from.id)) === userId;
  try {
    await ctx.app.tg.call("editMessageReplyMarkup", { chat_id: ctx.chatId, message_id: ctx.messageId, reply_markup: contactKeyboard(contact, selected, usesThreads(ctx.app)) });
  } catch (error) {
    if (error instanceof TelegramError && error.notModified) return;
    throw error;
  }
}

async function setContactFlag(ctx: Ctx, userId: number, sql: string, ...values: (string | number | null)[]): Promise<void> {
  await ctx.app.db.prepare(sql).bind(...values, userId).run();
  await refreshCard(ctx, userId);
}

async function ownerAction(ctx: Ctx, action: string, arg: string, extra: string | undefined): Promise<boolean> {
  const { app } = ctx;
  switch (action) {
    case "m": {
      const menu = renderMenu(app, arg);
      await edit(ctx, menu.text, menu.keyboard);
      return true;
    }
    case "mt": {
      const toggle = TOGGLES[arg];
      if (!toggle) return false;
      await saveSetting(app.db, app.settings, toggle.key, !app.settings[toggle.key]);
      const menu = renderMenu(app, toggle.page);
      await edit(ctx, menu.text, menu.keyboard);
      return true;
    }
    case "mi": {
      const spec = INPUTS[arg];
      if (!spec) return false;
      await setAwaiting(app, ctx.query.from.id, arg);
      await app.tg.call("sendMessage", { chat_id: ctx.chatId, text: spec.prompt, reply_markup: CANCEL_KEYBOARD });
      return true;
    }
    case "mc":
      if (arg === "verifyMode" && (extra === "off" || extra === "quiz")) {
        await saveSetting(app.db, app.settings, "verifyMode", extra);
        const menu = renderMenu(app, "verify");
        await edit(ctx, menu.text, menu.keyboard);
        return true;
      }
      if (arg === "deskMode" && (extra === "dm" || extra === "dm_topics")) {
        if (extra === "dm_topics" && !(await fetchBot(app)).hasTopics) {
          await ctx.answer("机器人还没开话题模式。到 @BotFather 的 Mini App 打开后再试。", true);
          return true;
        }
        await saveSetting(app.db, app.settings, "deskMode", extra);
        await saveSetting(app.db, app.settings, "groupId", null);
        await app.db.prepare("UPDATE contacts SET thread_id = NULL, thread_claim_at = NULL").run();
        await syncCommands(app);
        const menu = renderMenu(app, "desk");
        await edit(ctx, menu.text, menu.keyboard);
        return true;
      }
      return false;
    case "flood_off":
      await saveSetting(app.db, app.settings, "floodUntil", 0);
      await saveSetting(app.db, app.settings, "floodCountFrom", app.now());
      await edit(ctx, "防护已解除。");
      return true;
    case "bc_go": {
      const id = positiveInt(arg);
      if (id === null) return false;
      const changed = await app.db.prepare("UPDATE broadcasts SET state = 'running' WHERE id = ? AND state = 'draft'").bind(id).run();
      await edit(ctx, changed ? "开始群发，每分钟发一批，完成后告诉你。" : "这次群发已经处理过了。", changed ? { inline_keyboard: [[{ text: "🛑 取消群发", callback_data: "bcx" }]] } : undefined);
      if (changed) app.defer(() => broadcastTick(app), 0);
      return true;
    }
    case "bc_no": {
      const id = positiveInt(arg);
      if (id === null) return false;
      await app.db.prepare("UPDATE broadcasts SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'draft'").bind(app.now(), id).run();
      await edit(ctx, "已取消群发。");
      return true;
    }
    case "clean?": {
      const days = positiveInt(arg);
      if (days === null) return false;
      const cutoff = days === 0 ? app.now() + 1 : app.now() - days * 86_400;
      const row = await app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE created_at < ? AND (text IS NOT NULL OR file_id IS NOT NULL)").bind(cutoff).first<{ n: unknown }>();
      await edit(ctx, `会抹掉${days === 0 ? "全部" : ` ${days} 天前的`} ${num(row?.n)} 条记录的内容，不能恢复。\n联系人和回复关系保留。`, {
        inline_keyboard: [[{ text: `🧹 确认清理 ${num(row?.n)} 条`, callback_data: `clean!:${days}` }, { text: "❌ 取消", callback_data: "cl" }]],
      });
      return true;
    }
    case "clean!": {
      const days = positiveInt(arg);
      if (days === null) return false;
      const cutoff = days === 0 ? app.now() + 1 : app.now() - days * 86_400;
      const changed = await app.db.prepare("UPDATE messages SET text = NULL, file_id = NULL WHERE created_at < ? AND (text IS NOT NULL OR file_id IS NOT NULL)").bind(cutoff).run();
      await edit(ctx, `已清理 ${changed} 条。`, { inline_keyboard: [backRow()] });
      return true;
    }
    default:
      return false;
  }
}

const OWNER_ACTIONS = new Set(["m", "mt", "mi", "mc", "flood_off", "bc_go", "bc_no", "clean?", "clean!"]);

async function staffAction(ctx: Ctx, action: string, arg: string, extra: string | undefined): Promise<void> {
  const { app, query } = ctx;
  if (action === "dismiss") return await deleteQuietly(ctx);
  if (action === "list") {
    const page = await renderSessions(app, positiveInt(arg) ?? 0);
    return await edit(ctx, page.text, page.keyboard);
  }
  if (action === "filtered") {
    const page = await renderFiltered(app, positiveInt(arg) ?? 0);
    return await edit(ctx, page.text, page.keyboard);
  }
  if (action === "release") {
    const id = positiveInt(arg);
    const stored = id === null ? null : await findById(app, id);
    if (!stored || stored.status !== "filtered") return await ctx.answer("这条已经处理过了。", true);
    const contact = await getContact(app, stored.userId);
    if (!contact) return await ctx.answer("联系人不存在。", true);
    await releaseOne(app, stored, contact);
    await ctx.answer("已放行");
    const page = await renderFiltered(app, 0);
    return await edit(ctx, page.text, page.keyboard);
  }
  const userId = positiveInt(arg);
  if (userId === null) return;
  const contact = await getContact(app, userId);
  if (!contact) return await ctx.answer("联系人不存在。", true);
  switch (action) {
    case "select":
      await setSelected(app, query.from.id, userId);
      await app.db.prepare("UPDATE contacts SET unread = 0 WHERE user_id = ?").bind(userId).run();
      await ctx.answer("已选中，接下来发的消息都给这个人。");
      return await refreshCard(ctx, userId);
    case "unselect":
      await setSelected(app, query.from.id, null);
      await ctx.answer("已取消选中。");
      return await refreshCard(ctx, userId);
    case "open":
      await app.db.prepare("UPDATE contacts SET unread = 0 WHERE user_id = ?").bind(userId).run();
      contact.unread = 0;
      return await edit(ctx, cardText(app, contact), {
        inline_keyboard: [...contactKeyboard(contact, (await selectedUser(app, query.from.id)) === userId, usesThreads(app)).inline_keyboard, [{ text: "⬅️ 返回列表", callback_data: "list:0" }]],
      });
    case "history": {
      const page = await renderHistory(app, userId, positiveInt(extra) ?? 0);
      await app.tg.call("sendMessage", {
        chat_id: ctx.chatId,
        ...(query.message?.message_thread_id === undefined ? {} : { message_thread_id: query.message.message_thread_id }),
        text: page.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(page.keyboard === undefined ? {} : { reply_markup: page.keyboard }),
      });
      return;
    }
    case "note":
      await setAwaiting(app, query.from.id, `note:${userId}`);
      await app.tg.call("sendMessage", {
        chat_id: ctx.chatId,
        ...(query.message?.message_thread_id === undefined ? {} : { message_thread_id: query.message.message_thread_id }),
        parse_mode: "HTML",
        text: `给 ${identityHtml(contact)} 写备注，发 0 清空。`,
        reply_markup: CANCEL_KEYBOARD,
      });
      return;
    case "block":
      return await setContactFlag(ctx, userId, "UPDATE contacts SET blocked_at = ? WHERE user_id = ?", app.now());
    case "unblock":
      return await setContactFlag(ctx, userId, "UPDATE contacts SET blocked_at = NULL WHERE user_id = ?");
    case "exempt":
      return await setContactFlag(ctx, userId, "UPDATE contacts SET verify_exempt = 1 WHERE user_id = ?");
    case "unexempt":
      return await setContactFlag(ctx, userId, "UPDATE contacts SET verify_exempt = 0 WHERE user_id = ?");
    case "unlock":
      await setContactFlag(ctx, userId, "UPDATE contacts SET locked_until = NULL, failed_attempts = 0 WHERE user_id = ?");
      return await ctx.answer("已解除锁定。");
    case "approve": {
      await app.db.prepare("UPDATE contacts SET approved_at = ? WHERE user_id = ?").bind(app.now(), userId).run();
      contact.approvedAt = app.now();
      const rows = await app.db.prepare("SELECT * FROM messages WHERE user_id = ? AND status = 'filtered' ORDER BY id LIMIT 10").bind(userId).all();
      for (const row of rows) await releaseOne(app, toMessage(row), contact);
      await ctx.answer(`已放行 ${rows.length} 条`);
      await edit(ctx, `已放行：${identityHtml(contact)}`);
      return;
    }
    default:
      return;
  }
}

export async function handleCallback(app: App, query: CallbackQuery): Promise<void> {
  const data = query.data ?? "";
  const message = query.message;
  let answered = false;
  const answer = async (text?: string, alert = false) => {
    if (answered) return;
    answered = true;
    await app.tg.call("answerCallbackQuery", { callback_query_id: query.id, ...(text === undefined ? {} : { text, show_alert: alert }) });
  };
  if (!message) return await answer("这条消息太旧了，操作不了。", true);
  const ctx: Ctx = { app, query, chatId: message.chat.id, messageId: message.message_id, answer };
  const [action = "", arg = "", extra] = data.split(":");

  if (action === "v" || action === "vr") {
    if (message.chat.type !== "private") return await answer();
    if (action === "v") {
      await onVerify(ctx, arg, extra ?? "");
    } else {
      const contact = await getContact(app, query.from.id);
      if (contact && contact.challengeId === arg) {
        await deleteQuietly(ctx);
        await sendChallenge(app, contact);
      }
    }
    return await answer();
  }

  if (action === "claim") {
    if (message.chat.type !== "private") return await answer();
    const result = await claimByButton(app, query.from, message.chat.id, arg);
    if (result === "ok") await deleteQuietly(ctx);
    else if (result === "wrong") await edit(ctx, "图案不对，按钮已失效。\n部署的人可以用服务器终端里的链接绑定，或在服务器上运行 tgbot claim 换一个新图案。");
    else await edit(ctx, "这个按钮已经失效：机器人已有管理员，或已经过期。找部署的人重新开放。");
    return await answer();
  }

  // 只认主人私聊和绑定的话题群里的按钮。防的是别的聊天里残留的旧按钮。
  const fromOwnerDm = message.chat.id === app.settings.ownerId && isOwner(app, query.from.id);
  const fromGroup = app.settings.deskMode === "group" && message.chat.id === app.settings.groupId;
  if (!fromOwnerDm && !fromGroup) return await answer();
  // 点了别的按钮就是不想继续输入了，否则接下来发的话会被当成输入，发不到客户那里
  await clearAwaiting(app, query.from.id);
  if (PANEL_ACTIONS.has(action)) {
    if (PANEL_OWNER_ACTIONS.has(action) && !isOwner(app, query.from.id)) return await answer("只有主人能操作。", true);
    await panelAction(ctx, action, arg, extra);
  } else if (OWNER_ACTIONS.has(action)) {
    if (!isOwner(app, query.from.id)) return await answer("只有主人能操作。", true);
    if (!(await ownerAction(ctx, action, arg, extra))) app.log("warn", "收到无法识别的主人操作", action);
  } else {
    await staffAction(ctx, action, arg, extra);
  }
  await answer();
}

