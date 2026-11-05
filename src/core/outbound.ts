// 管理员消息流水线：弄清要发给谁，复制过去，记账。成功只点一个表态，失败才说话，不刷屏。
import type { Message } from "@grammyjs/types";
import { bufferAlbum } from "./album.ts";
import type { App } from "./app.ts";
import type { Contact } from "./contacts.ts";
import { dayKey, findByThread, fullName, getContact } from "./contacts.ts";
import { usesThreads } from "./desk.ts";
import { describe, escapeHtml } from "./message-info.ts";
import { insertMessage, resolveDeskMessage } from "./messages.ts";
import type { StoredMessage } from "./messages.ts";
import { TelegramError } from "./telegram.ts";

export interface Route {
  contact: Contact;
  stored: StoredMessage | null;
}

export async function selectedUser(app: App, staffId: number): Promise<number | null> {
  const row = await app.db.prepare("SELECT selected_user_id FROM staff_state WHERE staff_id = ?").bind(staffId).first<{ selected_user_id: unknown }>();
  return row && typeof row.selected_user_id === "number" ? row.selected_user_id : null;
}

export async function setSelected(app: App, staffId: number, userId: number | null): Promise<void> {
  await app.db
    .prepare("INSERT INTO staff_state(staff_id, selected_user_id) VALUES(?, ?) ON CONFLICT(staff_id) DO UPDATE SET selected_user_id = excluded.selected_user_id")
    .bind(staffId, userId)
    .run();
}

/** 回复优先，其次话题，最后才看选中的会话。 */
export async function routeOf(app: App, message: Message, staffId: number): Promise<Route | null> {
  const reply = message.reply_to_message;
  // 话题里的普通消息也可能带 reply_to_message，指向话题创建的服务消息，这种不算引用
  if (reply && !Object.hasOwn(reply, "forum_topic_created")) {
    const resolved = await resolveDeskMessage(app, message.chat.id, reply.message_id);
    if (resolved) {
      const contact = await getContact(app, resolved.userId);
      if (contact) return { contact, stored: resolved.stored };
    }
  }
  if (usesThreads(app) && message.message_thread_id !== undefined) {
    const contact = await findByThread(app, message.message_thread_id);
    if (contact) return { contact, stored: null };
  }
  if (app.settings.deskMode === "group") return null;
  // 明确引用了一条认不出的消息时不能退回「选中」：管理员以为在回 A，消息却发给选中的 B
  if (reply && !Object.hasOwn(reply, "forum_topic_created")) return null;
  const selected = await selectedUser(app, staffId);
  if (selected === null) return null;
  const contact = await getContact(app, selected);
  return contact ? { contact, stored: null } : null;
}

async function reactOk(app: App, message: Message, emoji: string): Promise<void> {
  try {
    await app.tg.call("setMessageReaction", { chat_id: message.chat.id, message_id: message.message_id, reaction: [{ type: "emoji", emoji }] });
  } catch (error) {
    // 表态只是提示，失败不影响消息已发出
    app.log("warn", "设置表态失败", error instanceof Error ? error.message : String(error));
  }
}

async function say(app: App, message: Message, text: string): Promise<void> {
  await app.tg.call("sendMessage", {
    chat_id: message.chat.id,
    ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    text,
    parse_mode: "HTML",
  });
}

export function failureText(contact: Contact, error: unknown): string {
  const name = escapeHtml(fullName(contact));
  if (error instanceof TelegramError && error.userUnreachable) return `没发出去：${name} 已拉黑机器人或账号不可用。`;
  if (error instanceof TelegramError) return `没发出去：${escapeHtml(error.description)}`;
  return `没发出去：${escapeHtml(error instanceof Error ? error.message : String(error))}`;
}

export function replyStats(app: App, contact: Contact) {
  const waited = contact.firstUnreadAt === null ? null : Math.max(0, app.now() - contact.firstUnreadAt);
  const day = dayKey(app.now(), app.settings.timezone);
  return app.db
    .prepare(
      `INSERT INTO daily_stats(day, outbound, reply_seconds, replies) VALUES(?, 1, ?, ?)
       ON CONFLICT(day) DO UPDATE SET outbound = outbound + 1, reply_seconds = reply_seconds + excluded.reply_seconds, replies = replies + excluded.replies`,
    )
    .bind(day, waited ?? 0, waited === null ? 0 : 1);
}

/** 记账并把未读清零。发文字、复制消息共用。 */
export async function recordOutbound(app: App, contact: Contact, input: { kind: string; text: string; fileId: string; userMsgId: number; deskChatId: number; deskMsgId: number; staffId: number }): Promise<void> {
  await app.db.batch([
    insertMessage(app, { userId: contact.userId, direction: "out", kind: input.kind, text: input.text, fileId: input.fileId, userMsgId: input.userMsgId, deskChatId: input.deskChatId, deskMsgId: input.deskMsgId, staffId: input.staffId, status: "sent" }),
    replyStats(app, contact),
    app.db.prepare("UPDATE contacts SET unread = 0, first_unread_at = NULL, unreachable_at = NULL WHERE user_id = ?").bind(contact.userId),
  ]);
}

export async function markUnreachable(app: App, contact: Contact): Promise<void> {
  await app.db.prepare("UPDATE contacts SET unreachable_at = ? WHERE user_id = ?").bind(app.now(), contact.userId).run();
}

export async function handleStaffMessage(app: App, message: Message, staffId: number): Promise<void> {
  const route = await routeOf(app, message, staffId);
  if (!route) {
    // 话题群的 General 里闲聊不提示，也不转发
    if (app.settings.deskMode === "group") return;
    await say(app, message, message.reply_to_message ? "认不出这条引用是谁的消息，这条没发出去。\n点 /list 选一个会话。" : "现在没选中会话，这条没发出去。\n回复某条消息，或点卡片上的「选中」。");
    return;
  }
  const { contact, stored } = route;
  const info = describe(message);
  // 双斜杠开头是内部备注，留在客服台，不发给对方
  if (info.text.startsWith("//")) {
    await reactOk(app, message, "✍");
    return;
  }
  if (contact.blockedAt !== null) {
    await say(app, message, "这个联系人已被屏蔽，先解除屏蔽再回复。");
    return;
  }
  if (message.media_group_id) {
    await bufferAlbum(app, { message, info, groupId: message.media_group_id, direction: "out", userId: contact.userId, staffId });
    return;
  }
  try {
    const quote = stored?.userMsgId ?? null;
    const copied = await app.tg.call<{ message_id: number }>("copyMessage", {
      chat_id: contact.userId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
      ...(quote === null ? {} : { reply_parameters: { message_id: quote, allow_sending_without_reply: true } }),
    });
    await recordOutbound(app, contact, { kind: info.kind, text: info.text, fileId: info.fileId, userMsgId: copied.message_id, deskChatId: message.chat.id, deskMsgId: message.message_id, staffId });
    await reactOk(app, message, "👌");
  } catch (error) {
    if (error instanceof TelegramError && error.userUnreachable) await markUnreachable(app, contact);
    app.log("warn", `回复联系人 ${contact.userId} 失败`, error instanceof Error ? error.message : String(error));
    await say(app, message, failureText(contact, error));
  }
}

