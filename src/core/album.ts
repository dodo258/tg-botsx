// 媒体组：Telegram 把一组图拆成多条更新发来。先存进缓冲表，等最后一张到后 1.5 秒再用 copyMessages 一起发，相册不会被拆开。
import type { Message } from "@grammyjs/types";
import type { App } from "./app.ts";
import { getContact, bumpDaily } from "./contacts.ts";
import { num, str, strOrNull } from "./db.ts";
import { resolveTarget, withThreadRecovery } from "./desk.ts";
import { insertMessage } from "./messages.ts";
import type { MessageInfo } from "./message-info.ts";
import { TelegramError } from "./telegram.ts";

const SETTLE_MS = 1500;

interface BufferInput {
  message: Message;
  info: MessageInfo;
  groupId: string;
  direction: "in" | "out";
  userId: number;
  staffId: number | null;
}

export async function bufferAlbum(app: App, input: BufferInput): Promise<void> {
  await app.db
    .prepare(
      `INSERT OR IGNORE INTO album_buffer(group_id, direction, from_chat_id, message_id, user_id, staff_id, thread_id, kind, text, file_id, added_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.groupId, input.direction, input.message.chat.id, input.message.message_id, input.userId, input.staffId, input.message.message_thread_id ?? null, input.info.kind, input.info.text || null, input.info.fileId || null, app.nowMs())
    .run();
  app.defer(() => flushAlbum(app, input.groupId), SETTLE_MS);
}

/** 每张图都会排一次，只有距离最后一张够久的那次真正发送。 */
export async function flushAlbum(app: App, groupId: string): Promise<void> {
  const rows = await app.db.prepare("SELECT * FROM album_buffer WHERE group_id = ? ORDER BY message_id").bind(groupId).all();
  const newest = rows.reduce((latest, row) => Math.max(latest, num(row.added_at)), 0);
  if (rows.length === 0 || app.nowMs() - newest < SETTLE_MS - 100) return;
  // 抢占：删除成功的才发送，避免重复
  const taken = await app.db.prepare("DELETE FROM album_buffer WHERE group_id = ?").bind(groupId).run();
  if (taken === 0) return;
  const first = rows[0];
  if (!first) return;
  const userId = num(first.user_id);
  const fromChat = num(first.from_chat_id);
  const ids = rows.map((row) => num(row.message_id));
  const contact = await getContact(app, userId);
  if (!contact) return;
  try {
    if (str(first.direction) === "in") {
      const start = await resolveTarget(app, contact);
      const copied = await withThreadRecovery(app, contact, start, (target) =>
        app.tg.call<{ message_id: number }[]>("copyMessages", {
          chat_id: target.chatId,
          from_chat_id: fromChat,
          message_ids: ids,
          ...(target.threadId === null ? {} : { message_thread_id: target.threadId }),
        }).then((result) => ({ result, chatId: target.chatId })),
      );
      await app.db.batch([
        ...rows.map((row, index) =>
          insertMessage(app, {
            userId,
            direction: "in",
            kind: str(row.kind),
            text: strOrNull(row.text) ?? "",
            fileId: strOrNull(row.file_id) ?? "",
            userMsgId: num(row.message_id),
            deskChatId: copied.chatId,
            deskMsgId: copied.result[index]?.message_id ?? null,
            staffId: null,
            status: "sent",
          }),
        ),
        app.db
          .prepare("UPDATE contacts SET msg_count = msg_count + ?, unread = unread + ?, first_unread_at = COALESCE(first_unread_at, ?), last_inbound_at = ? WHERE user_id = ?")
          .bind(rows.length, rows.length, app.now(), app.now(), userId),
        bumpDaily(app, "inbound", rows.length),
      ]);
    } else {
      const copied = await app.tg.call<{ message_id: number }[]>("copyMessages", { chat_id: userId, from_chat_id: fromChat, message_ids: ids });
      await app.db.batch([
        ...rows.map((row, index) =>
          insertMessage(app, {
            userId,
            direction: "out",
            kind: str(row.kind),
            text: strOrNull(row.text) ?? "",
            fileId: strOrNull(row.file_id) ?? "",
            userMsgId: copied[index]?.message_id ?? null,
            deskChatId: fromChat,
            deskMsgId: num(row.message_id),
            staffId: typeof row.staff_id === "number" ? row.staff_id : null,
            status: "sent",
          }),
        ),
        app.db.prepare("UPDATE contacts SET unread = 0, first_unread_at = NULL WHERE user_id = ?").bind(userId),
        bumpDaily(app, "outbound", rows.length),
      ]);
    }
  } catch (error) {
    app.log("error", `媒体组发送失败（联系人 ${userId}）`, error instanceof Error ? error.message : String(error));
    const description = error instanceof TelegramError ? error.description : "未知错误";
    await app.db.batch(
      rows.map((row) =>
        insertMessage(app, {
          userId,
          direction: str(first.direction) === "in" ? "in" : "out",
          kind: str(row.kind),
          text: strOrNull(row.text) ?? "",
          fileId: strOrNull(row.file_id) ?? "",
          userMsgId: str(first.direction) === "in" ? num(row.message_id) : null,
          deskChatId: null,
          deskMsgId: null,
          staffId: null,
          status: "failed",
          reason: description,
        }),
      ),
    );
    if (str(first.direction) === "out") {
      await app.tg.call("sendMessage", { chat_id: fromChat, text: `相册没有发出去：${description}`, ...(typeof first.thread_id === "number" ? { message_thread_id: first.thread_id } : {}) }).catch((notifyError: unknown) => {
        app.log("error", "通知管理员相册发送失败时出错", notifyError instanceof Error ? notifyError.message : String(notifyError));
      });
    }
  }
}
