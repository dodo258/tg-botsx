// 消息表：既是聊天记录，也是双向映射。任何路由都查这里，不依赖 forward_from。
import type { App } from "./app.ts";
import type { Row, SqlValue, Statement } from "./db.ts";
import { num, numOrNull, str, strOrNull } from "./db.ts";

export interface StoredMessage {
  id: number;
  userId: number;
  direction: "in" | "out";
  kind: string;
  text: string | null;
  fileId: string | null;
  userMsgId: number | null;
  deskChatId: number | null;
  deskMsgId: number | null;
  staffId: number | null;
  status: string;
  reason: string | null;
  createdAt: number;
  retractedAt: number | null;
}

export function toMessage(row: Row): StoredMessage {
  return {
    id: num(row.id),
    userId: num(row.user_id),
    direction: row.direction === "out" ? "out" : "in",
    kind: str(row.kind),
    text: strOrNull(row.text),
    fileId: strOrNull(row.file_id),
    userMsgId: numOrNull(row.user_msg_id),
    deskChatId: numOrNull(row.desk_chat_id),
    deskMsgId: numOrNull(row.desk_msg_id),
    staffId: numOrNull(row.staff_id),
    status: str(row.status),
    reason: strOrNull(row.reason),
    createdAt: num(row.created_at),
    retractedAt: numOrNull(row.retracted_at),
  };
}

export interface NewMessage {
  userId: number;
  direction: "in" | "out";
  kind: string;
  text: string;
  fileId: string;
  userMsgId: number | null;
  deskChatId: number | null;
  deskMsgId: number | null;
  staffId: number | null;
  status: "sent" | "failed" | "filtered";
  reason?: string;
}

export function insertMessage(app: App, message: NewMessage): Statement {
  const values: SqlValue[] = [
    message.userId,
    message.direction,
    message.kind,
    message.text || null,
    message.fileId || null,
    message.userMsgId,
    message.deskChatId,
    message.deskMsgId,
    message.staffId,
    message.status,
    message.reason ?? null,
    app.now(),
  ];
  return app.db
    .prepare(
      `INSERT INTO messages(user_id, direction, kind, text, file_id, user_msg_id, desk_chat_id, desk_msg_id, staff_id, status, reason, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(...values);
}

export async function findByDesk(app: App, chatId: number, messageId: number): Promise<StoredMessage | null> {
  const row = await app.db.prepare("SELECT * FROM messages WHERE desk_chat_id = ? AND desk_msg_id = ? ORDER BY id DESC LIMIT 1").bind(chatId, messageId).first();
  return row ? toMessage(row) : null;
}

export async function findByUserMsg(app: App, userId: number, messageId: number): Promise<StoredMessage | null> {
  const row = await app.db.prepare("SELECT * FROM messages WHERE user_id = ? AND user_msg_id = ? ORDER BY id DESC LIMIT 1").bind(userId, messageId).first();
  return row ? toMessage(row) : null;
}

export async function findById(app: App, id: number): Promise<StoredMessage | null> {
  const row = await app.db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
  return row ? toMessage(row) : null;
}

/** 客服台某条消息属于哪个联系人：先查消息映射，再查会话卡片。 */
export async function resolveDeskMessage(app: App, chatId: number, messageId: number): Promise<{ userId: number; stored: StoredMessage | null } | null> {
  const stored = await findByDesk(app, chatId, messageId);
  if (stored) return { userId: stored.userId, stored };
  const card = await app.db.prepare("SELECT user_id FROM cards WHERE chat_id = ? AND message_id = ?").bind(chatId, messageId).first<{ user_id: unknown }>();
  return card ? { userId: num(card.user_id), stored: null } : null;
}
