// 联系人表的读写。一条入站消息尽量只碰一次这张表，省 D1 的查询和写入额度。
import type { User } from "@grammyjs/types";
import type { App } from "./app.ts";
import type { Row } from "./db.ts";
import { num, numOrNull, str, strOrNull } from "./db.ts";
import { escapeHtml } from "./message-info.ts";

export interface Contact {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  languageCode: string;
  firstSeen: number;
  lastSeen: number;
  lastInboundAt: number | null;
  lastCardAt: number | null;
  lastCardMsgId: number | null;
  unread: number;
  firstUnreadAt: number | null;
  msgCount: number;
  note: string;
  blockedAt: number | null;
  blockReason: string;
  unreachableAt: number | null;
  threadId: number | null;
  threadClaimAt: number | null;
  verifiedAt: number | null;
  verifyExempt: boolean;
  approvedAt: number | null;
  challengeId: string | null;
  challengeToken: string | null;
  challengeAt: number | null;
  failedAttempts: number;
  lockedUntil: number | null;
  rateWindow: number;
  rateCount: number;
  mutedUntil: number | null;
  lastReceiptAt: number | null;
  lastOfflineAt: number | null;
}

export function toContact(row: Row): Contact {
  return {
    userId: num(row.user_id),
    username: str(row.username),
    firstName: str(row.first_name),
    lastName: str(row.last_name),
    languageCode: str(row.language_code),
    firstSeen: num(row.first_seen),
    lastSeen: num(row.last_seen),
    lastInboundAt: numOrNull(row.last_inbound_at),
    lastCardAt: numOrNull(row.last_card_at),
    lastCardMsgId: numOrNull(row.last_card_msg_id),
    unread: num(row.unread),
    firstUnreadAt: numOrNull(row.first_unread_at),
    msgCount: num(row.msg_count),
    note: str(row.note),
    blockedAt: numOrNull(row.blocked_at),
    blockReason: str(row.block_reason),
    unreachableAt: numOrNull(row.unreachable_at),
    threadId: numOrNull(row.thread_id),
    threadClaimAt: numOrNull(row.thread_claim_at),
    verifiedAt: numOrNull(row.verified_at),
    verifyExempt: num(row.verify_exempt) === 1,
    approvedAt: numOrNull(row.approved_at),
    challengeId: strOrNull(row.challenge_id),
    challengeToken: strOrNull(row.challenge_token),
    challengeAt: numOrNull(row.challenge_at),
    failedAttempts: num(row.failed_attempts),
    lockedUntil: numOrNull(row.locked_until),
    rateWindow: num(row.rate_window),
    rateCount: num(row.rate_count),
    mutedUntil: numOrNull(row.muted_until),
    lastReceiptAt: numOrNull(row.last_receipt_at),
    lastOfflineAt: numOrNull(row.last_offline_at),
  };
}

/** 写入或更新联系人并返回最新一行。isNew 用于新联系人统计和防轰炸。 */
export async function touchContact(app: App, user: User): Promise<{ contact: Contact; isNew: boolean }> {
  const now = app.now();
  const row = await app.db
    .prepare(
      `INSERT INTO contacts(user_id, username, first_name, last_name, language_code, first_seen, last_seen)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username, first_name = excluded.first_name, last_name = excluded.last_name,
         language_code = excluded.language_code, last_seen = excluded.last_seen, touches = touches + 1, unreachable_at = NULL
       RETURNING *`,
    )
    .bind(user.id, user.username ?? "", user.first_name ?? "", user.last_name ?? "", user.language_code ?? "", now, now)
    .first();
  if (!row) throw new Error("写入联系人后没有返回记录");
  return { contact: toContact(row), isNew: num(row.touches) === 1 };
}

export async function getContact(app: App, userId: number): Promise<Contact | null> {
  const row = await app.db.prepare("SELECT * FROM contacts WHERE user_id = ?").bind(userId).first();
  return row ? toContact(row) : null;
}

export async function findByThread(app: App, threadId: number): Promise<Contact | null> {
  const row = await app.db.prepare("SELECT * FROM contacts WHERE thread_id = ?").bind(threadId).first();
  return row ? toContact(row) : null;
}

export function fullName(contact: Pick<Contact, "firstName" | "lastName" | "username" | "userId">): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  return contact.username ? `@${contact.username}` : `用户 ${contact.userId}`;
}

/** 单行身份：名字可点开资料（对方隐私设置允许时），后面跟用户名和数字 ID。 */
export function identityHtml(contact: Contact): string {
  const name = escapeHtml(fullName(contact));
  const handle = contact.username ? ` @${escapeHtml(contact.username)}` : "";
  return `<a href="tg://user?id=${contact.userId}">${name}</a>${handle} · <code>${contact.userId}</code>`;
}

/** 按时区格式化。Worker 和 Node 都带完整的 Intl。 */
export function formatTime(seconds: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(seconds * 1000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function dayKey(seconds: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(seconds * 1000));
  return parts;
}

export type DailyField = "inbound" | "outbound" | "new_contacts" | "filtered";

export function bumpDaily(app: App, field: DailyField, amount = 1) {
  const day = dayKey(app.now(), app.settings.timezone);
  return app.db
    .prepare(`INSERT INTO daily_stats(day, ${field}) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + excluded.${field}`)
    .bind(day, amount);
}
