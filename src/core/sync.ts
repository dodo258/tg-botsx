// 编辑和表态的双向同步，以及撤回。Telegram 不告诉普通机器人「用户删除了消息」，所以用户侧的删除同步不了。
import type { Message, MessageReactionUpdated } from "@grammyjs/types";
import type { App } from "./app.ts";
import { getContact } from "./contacts.ts";
import { copyToDesk, deskChatId } from "./desk.ts";
import { describe, escapeHtml } from "./message-info.ts";
import { findByDesk, findByUserMsg } from "./messages.ts";
import type { StoredMessage } from "./messages.ts";
import { TelegramError } from "./telegram.ts";

async function pushEdit(app: App, chatId: number, messageId: number, message: Message): Promise<void> {
  try {
    if (message.text !== undefined) {
      await app.tg.call("editMessageText", { chat_id: chatId, message_id: messageId, text: message.text, entities: message.entities ?? [] });
    } else {
      await app.tg.call("editMessageCaption", { chat_id: chatId, message_id: messageId, caption: message.caption ?? "", caption_entities: message.caption_entities ?? [] });
    }
  } catch (error) {
    if (error instanceof TelegramError && error.notModified) return;
    throw error;
  }
}

async function saveEdit(app: App, stored: StoredMessage, text: string, fileId: string): Promise<void> {
  await app.db.prepare("UPDATE messages SET text = ?, file_id = ?, edited_at = ? WHERE id = ?").bind(text || null, fileId || null, app.now(), stored.id).run();
}

/** 对方改了消息：同步到客服台，并在下面留一条原文，方便管理员看到改了什么。 */
export async function handleContactEdit(app: App, message: Message, userId: number): Promise<void> {
  const stored = await findByUserMsg(app, userId, message.message_id);
  if (!stored || stored.direction !== "in" || stored.deskChatId === null || stored.deskMsgId === null) return;
  const contact = await getContact(app, userId);
  if (!contact) return;
  const info = describe(message);
  const thread = contact.threadId === null ? {} : { message_thread_id: contact.threadId };
  const before = stored.text ?? "";
  const fileChanged = info.fileId !== "" && info.fileId !== (stored.fileId ?? "");
  try {
    if (fileChanged) {
      const copied = await copyToDesk(app, contact, message, stored.deskMsgId);
      await app.db.prepare("UPDATE messages SET desk_msg_id = ?, text = ?, file_id = ?, edited_at = ? WHERE id = ?").bind(copied.deskMsgId, info.text || null, info.fileId, app.now(), stored.id).run();
      return;
    }
    await pushEdit(app, stored.deskChatId, stored.deskMsgId, message);
    await saveEdit(app, stored, info.text, info.fileId);
    await app.tg.call("sendMessage", {
      chat_id: stored.deskChatId,
      ...thread,
      reply_parameters: { message_id: stored.deskMsgId, allow_sending_without_reply: true },
      disable_notification: true,
      parse_mode: "HTML",
      text: before ? `对方改了这条消息，原文：\n<blockquote>${escapeHtml(before.slice(0, 1500))}</blockquote>` : "对方改了这条消息。",
    });
  } catch (error) {
    app.log("warn", `同步对方编辑失败（联系人 ${userId}）`, error instanceof Error ? error.message : String(error));
  }
}

/** 管理员改了自己发的消息：同步给对方。 */
export async function handleStaffEdit(app: App, message: Message): Promise<void> {
  const stored = await findByDesk(app, message.chat.id, message.message_id);
  if (!stored || stored.direction !== "out" || stored.userMsgId === null) return;
  const info = describe(message);
  try {
    if (info.fileId !== "" && info.fileId !== (stored.fileId ?? "")) {
      await replyTo(app, message, "换媒体同步不了，请 /del 撤回后重发。");
      return;
    }
    await pushEdit(app, stored.userId, stored.userMsgId, message);
    await saveEdit(app, stored, info.text, info.fileId);
  } catch (error) {
    await replyTo(app, message, `修改没能同步给对方：${error instanceof TelegramError ? escapeHtml(error.description) : "未知错误"}`);
  }
}

async function replyTo(app: App, message: Message, html: string): Promise<void> {
  await app.tg.call("sendMessage", {
    chat_id: message.chat.id,
    ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    parse_mode: "HTML",
    text: html,
  });
}

/** 表态同步。机器人一条消息只能设一个表态，取最新的第一个；自定义表情发不了，跳过。 */
export async function handleReaction(app: App, update: MessageReactionUpdated): Promise<void> {
  const emojis = update.new_reaction.flatMap((reaction) => (reaction.type === "emoji" ? [reaction.emoji] : []));
  const reaction = emojis.slice(0, 1).map((emoji) => ({ type: "emoji", emoji }));
  let chatId: number | null = null;
  let messageId: number | null = null;
  if (update.chat.id === deskChatId(app)) {
    const stored = await findByDesk(app, update.chat.id, update.message_id);
    if (stored) {
      chatId = stored.userId;
      messageId = stored.userMsgId;
    }
  } else if (update.chat.type === "private") {
    const stored = await findByUserMsg(app, update.chat.id, update.message_id);
    if (stored) {
      chatId = stored.deskChatId;
      messageId = stored.deskMsgId;
    }
  }
  if (chatId === null || messageId === null) return;
  try {
    await app.tg.call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction });
  } catch (error) {
    app.log("warn", "同步表态失败", error instanceof Error ? error.message : String(error));
  }
}

/** 撤回管理员发出的消息。Telegram 只允许删 48 小时内的。 */
export async function retract(app: App, stored: StoredMessage): Promise<string> {
  if (stored.direction !== "out" || stored.userMsgId === null) return "只能撤回自己发给对方的消息。";
  if (stored.retractedAt !== null) return "这条已经撤回过了。";
  try {
    await app.tg.call("deleteMessage", { chat_id: stored.userId, message_id: stored.userMsgId });
  } catch (error) {
    if (error instanceof TelegramError && error.messageMissing) return "撤回失败：消息已不存在，或已超过 48 小时。";
    throw error;
  }
  await app.db.prepare("UPDATE messages SET retracted_at = ? WHERE id = ?").bind(app.now(), stored.id).run();
  return "已撤回，对方那边看不到了。";
}
