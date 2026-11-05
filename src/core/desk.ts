// 客服台：把消息送到管理员看得到的地方。三种形态对上层一致：
//   dm        管理员和机器人的私聊，靠会话卡片区分联系人
//   dm_topics 私聊话题（Bot API 9.3 起），每个联系人一个话题，需要在 BotFather 打开
//   group     话题群，每个联系人一个话题，可多人协作
import type { Message } from "@grammyjs/types";
import type { App } from "./app.ts";
import type { Contact } from "./contacts.ts";
import { formatTime, fullName, identityHtml } from "./contacts.ts";
import { saveSetting } from "./settings.ts";
import { TelegramError } from "./telegram.ts";
import type { Params } from "./telegram.ts";
import { clipHtml, escapeHtml } from "./message-info.ts";

export interface DeskTarget {
  chatId: number;
  threadId: number | null;
}

/** 私聊模式下，同一个人连续发消息时多久补一张卡片 */
const CARD_REFRESH_SECONDS = 30 * 60;

export function deskChatId(app: App): number | null {
  return app.settings.deskMode === "group" ? app.settings.groupId : app.settings.ownerId;
}

export function usesThreads(app: App): boolean {
  return app.settings.deskMode !== "dm";
}

function threadParams(target: DeskTarget): Params {
  return target.threadId === null ? {} : { message_thread_id: target.threadId };
}

export function contactKeyboard(contact: Contact, selected: boolean, inTopic: boolean) {
  const rows: { text: string; callback_data: string }[][] = [];
  if (!inTopic) {
    rows.push([
      selected
        ? { text: "取消选中", callback_data: `unselect:${contact.userId}` }
        : { text: "选中，直接回复", callback_data: `select:${contact.userId}` },
      { text: "聊天记录", callback_data: `history:${contact.userId}:0` },
    ]);
  } else {
    rows.push([{ text: "聊天记录", callback_data: `history:${contact.userId}:0` }]);
  }
  rows.push([
    { text: contact.note ? "改备注" : "加备注", callback_data: `note:${contact.userId}` },
    contact.blockedAt === null
      ? { text: "屏蔽", callback_data: `block:${contact.userId}` }
      : { text: "解除屏蔽", callback_data: `unblock:${contact.userId}` },
  ]);
  rows.push([
    contact.verifyExempt
      ? { text: "恢复验证", callback_data: `unexempt:${contact.userId}` }
      : { text: "免验证", callback_data: `exempt:${contact.userId}` },
    ...(contact.lockedUntil !== null && contact.lockedUntil > 0 ? [{ text: "解除验证锁定", callback_data: `unlock:${contact.userId}` }] : []),
  ]);
  return { inline_keyboard: rows };
}

export function cardText(app: App, contact: Contact): string {
  const lines = [identityHtml(contact)];
  const meta = [`首次联系 ${formatTime(contact.firstSeen, app.settings.timezone)}`, `累计 ${contact.msgCount} 条`];
  if (contact.languageCode) meta.push(`语言 ${escapeHtml(contact.languageCode)}`);
  lines.push(meta.join(" · "));
  if (contact.note) lines.push(`备注：${clipHtml(contact.note, 1500)}`);
  if (contact.blockedAt !== null) lines.push(`已屏蔽${contact.blockReason ? `（${escapeHtml(contact.blockReason)}）` : ""}`);
  if (contact.unreachableAt !== null) lines.push("对方已拉黑机器人或账号不可用");
  return lines.join("\n");
}

async function sendCard(app: App, contact: Contact, target: DeskTarget): Promise<number> {
  const inTopic = target.threadId !== null;
  const sent = await app.tg.call<{ message_id: number }>("sendMessage", {
    chat_id: target.chatId,
    ...threadParams(target),
    text: cardText(app, contact),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    disable_notification: true,
    reply_markup: contactKeyboard(contact, false, inTopic),
  });
  const now = app.now();
  await app.db.batch([
    app.db.prepare("INSERT OR REPLACE INTO cards(chat_id, message_id, user_id, created_at) VALUES(?, ?, ?, ?)").bind(target.chatId, sent.message_id, contact.userId, now),
    app.db.prepare("UPDATE contacts SET last_card_at = ?, last_card_msg_id = ? WHERE user_id = ?").bind(now, sent.message_id, contact.userId),
  ]);
  contact.lastCardAt = now;
  contact.lastCardMsgId = sent.message_id;
  return sent.message_id;
}

/** 新建话题。用 thread_claim_at 抢占，防止并发时给同一个人建出两个话题。 */
async function createThread(app: App, chatId: number, contact: Contact): Promise<number> {
  const now = app.now();
  const claimed = await app.db
    .prepare("UPDATE contacts SET thread_claim_at = ? WHERE user_id = ? AND (thread_claim_at IS NULL OR thread_claim_at < ?)")
    .bind(now, contact.userId, now - 30)
    .run();
  if (claimed === 0) {
    const row = await app.db.prepare("SELECT thread_id FROM contacts WHERE user_id = ?").bind(contact.userId).first<{ thread_id: unknown }>();
    if (row && typeof row.thread_id === "number") return row.thread_id;
    throw new Error(`联系人 ${contact.userId} 的话题正在创建中`);
  }
  let threadId: number;
  try {
    const topic = await app.tg.call<{ message_thread_id: number }>("createForumTopic", {
      chat_id: chatId,
      name: `${fullName(contact)} · ${contact.userId}`.slice(0, 128),
    });
    threadId = topic.message_thread_id;
  } catch (error) {
    await app.db.prepare("UPDATE contacts SET thread_claim_at = NULL WHERE user_id = ?").bind(contact.userId).run();
    throw error;
  }
  await app.db.prepare("UPDATE contacts SET thread_id = ?, thread_claim_at = NULL WHERE user_id = ?").bind(threadId, contact.userId).run();
  contact.threadId = threadId;
  await sendCard(app, contact, { chatId, threadId });
  return threadId;
}

/** 找到这个联系人在客服台的位置，没有话题就建一个。私聊模式必要时补卡片。 */
export async function resolveTarget(app: App, contact: Contact): Promise<DeskTarget> {
  const chatId = deskChatId(app);
  if (chatId === null) throw new Error("还没有绑定管理员");
  if (usesThreads(app)) {
    const threadId = contact.threadId ?? (await createThread(app, chatId, contact));
    return { chatId, threadId };
  }
  const target: DeskTarget = { chatId, threadId: null };
  const staleCard = contact.lastCardAt === null || app.now() - contact.lastCardAt > CARD_REFRESH_SECONDS;
  if (app.settings.lastCardUser !== contact.userId || staleCard) {
    await sendCard(app, contact, target);
    await saveSetting(app.db, app.settings, "lastCardUser", contact.userId);
  }
  return target;
}

/** 话题被关闭就重开，被删除就重建后再试一次。 */
export async function withThreadRecovery<T>(app: App, contact: Contact, target: DeskTarget, send: (target: DeskTarget) => Promise<T>): Promise<T> {
  try {
    return await send(target);
  } catch (error) {
    if (!(error instanceof TelegramError) || target.threadId === null) throw error;
    if (error.threadClosed) {
      await app.tg.call("reopenForumTopic", { chat_id: target.chatId, message_thread_id: target.threadId });
      return await send(target);
    }
    if (error.threadMissing) {
      await app.db.prepare("UPDATE contacts SET thread_id = NULL, thread_claim_at = NULL WHERE user_id = ?").bind(contact.userId).run();
      contact.threadId = null;
      contact.threadClaimAt = null;
      const threadId = await createThread(app, target.chatId, contact);
      return await send({ chatId: target.chatId, threadId });
    }
    throw error;
  }
}

/** 引用参数：私聊模式默认引用会话卡片，这样每条消息上都看得到是谁发的。 */
export function quoteParams(messageId: number | null): Params {
  return messageId === null ? {} : { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } };
}

/** 复制联系人的消息到客服台。有些类型不能复制，就退回转发，再不行发一条说明，保证管理员知道有这条消息。 */
export async function copyToDesk(app: App, contact: Contact, message: Pick<Message, "message_id">, quoteId: number | null): Promise<{ deskMsgId: number; chatId: number }> {
  const first = await resolveTarget(app, contact);
  return await withThreadRecovery(app, contact, first, async (target) => {
    const quote = quoteId ?? (target.threadId === null ? contact.lastCardMsgId : null);
    const base: Params = { chat_id: target.chatId, ...threadParams(target) };
    try {
      const copied = await app.tg.call<{ message_id: number }>("copyMessage", {
        ...base,
        from_chat_id: contact.userId,
        message_id: message.message_id,
        ...quoteParams(quote),
      });
      return { deskMsgId: copied.message_id, chatId: target.chatId };
    } catch (error) {
      if (!(error instanceof TelegramError) || error.code !== 400 || error.threadMissing || error.threadClosed) throw error;
      app.log("warn", "复制消息失败，改用转发", error.description);
    }
    try {
      const forwarded = await app.tg.call<{ message_id: number }>("forwardMessage", { ...base, from_chat_id: contact.userId, message_id: message.message_id });
      return { deskMsgId: forwarded.message_id, chatId: target.chatId };
    } catch (error) {
      if (!(error instanceof TelegramError) || error.code !== 400 || error.threadMissing || error.threadClosed) throw error;
    }
    const notice = await app.tg.call<{ message_id: number }>("sendMessage", {
      ...base,
      text: "对方发来一条无法转发的消息（可能是受保护内容或新类型）。",
      ...quoteParams(quote),
    });
    return { deskMsgId: notice.message_id, chatId: target.chatId };
  });
}

/** 发一条系统通知到这个联系人所在的位置。 */
export async function noticeToDesk(app: App, contact: Contact, html: string, keyboard?: unknown): Promise<void> {
  const first = await resolveTarget(app, contact);
  await withThreadRecovery(app, contact, first, async (target) => {
    await app.tg.call("sendMessage", {
      chat_id: target.chatId,
      ...threadParams(target),
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
    });
  });
}

/** 发给机器人主人本人的通知，不依赖客服台模式。 */
export async function noticeToOwner(app: App, html: string, keyboard?: unknown): Promise<void> {
  if (app.settings.ownerId === null) return;
  await app.tg.call("sendMessage", {
    chat_id: app.settings.ownerId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
  });
}
