// 定时任务：群发、补发失败的消息、每日清理。每 20 秒跑一次，每次只干一小批。
import type { App } from "./app.ts";
import { dayKey, getContact } from "./contacts.ts";
import { num } from "./db.ts";
import { noticeToOwner, copyToDesk } from "./desk.ts";
import { toMessage } from "./messages.ts";
import { saveSetting } from "./settings.ts";
import { TelegramError } from "./telegram.ts";

const BROADCAST_BATCH = 25;
const BROADCAST_LEASE = 120;
const RETRY_BATCH = 8;
const RETRY_WINDOW = 24 * 3600;
const CONTENT_GRACE_DAYS = 365;

export async function broadcastTick(app: App): Promise<void> {
  const job = await app.db.prepare("SELECT * FROM broadcasts WHERE state = 'running' ORDER BY id LIMIT 1").first();
  if (!job) return;
  const id = num(job.id);
  // 租约：确认后的立即执行可能撞上定时任务，两边读到同一个游标就会重复发。抢不到就让对方干。
  const claimed = await app.db
    .prepare("UPDATE broadcasts SET locked_until = ? WHERE id = ? AND state = 'running' AND (locked_until IS NULL OR locked_until < ?)")
    .bind(app.now() + BROADCAST_LEASE, id, app.now())
    .run();
  if (claimed === 0) return;
  const fresh = await app.db.prepare("SELECT cursor, sent, failed FROM broadcasts WHERE id = ?").bind(id).first();
  const fromChat = num(job.from_chat_id);
  const fromMsg = num(job.from_msg_id);
  let cursor = num(fresh?.cursor);
  const recipients = await app.db
    .prepare("SELECT user_id FROM contacts WHERE user_id > ? AND blocked_at IS NULL AND unreachable_at IS NULL AND msg_count > 0 AND user_id != ? ORDER BY user_id LIMIT ?")
    .bind(cursor, app.settings.ownerId ?? 0, BROADCAST_BATCH)
    .all<{ user_id: unknown }>();
  if (recipients.length === 0) {
    await app.db.prepare("UPDATE broadcasts SET state = 'done', finished_at = ?, locked_until = NULL WHERE id = ?").bind(app.now(), id).run();
    await app.tg.call("sendMessage", { chat_id: num(job.report_chat_id), text: `群发完成：成功 ${num(fresh?.sent)}，失败 ${num(fresh?.failed)}。` });
    return;
  }
  let sent = 0;
  let failed = 0;
  const unreachable: number[] = [];
  for (const recipient of recipients) {
    if (app.isStopping?.()) break;
    const userId = num(recipient.user_id);
    try {
      await app.tg.call("copyMessage", { chat_id: userId, from_chat_id: fromChat, message_id: fromMsg });
      sent++;
    } catch (error) {
      // 被限流、网络问题或服务器出错就停在这一个，下一轮从这里继续。这些人不是真的发不到
      if (!(error instanceof TelegramError) || error.code === 429 || error.code === 0 || error.code === 401 || error.code >= 500) break;
      failed++;
      if (error instanceof TelegramError && error.userUnreachable) unreachable.push(userId);
    }
    cursor = userId;
    // 每发一个就记下进度：进程被杀也不会从头再发一遍
    await app.db.prepare("UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ? WHERE id = ?").bind(cursor, sent, failed, id).run();
    sent = 0;
    failed = 0;
  }
  await app.db.batch([
    app.db.prepare("UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ?, locked_until = NULL WHERE id = ?").bind(cursor, sent, failed, id),
    ...unreachable.map((userId) => app.db.prepare("UPDATE contacts SET unreachable_at = ? WHERE user_id = ?").bind(app.now(), userId)),
  ]);
}

/** 补发之前没送到客服台的消息（比如群聊被限流）。 */
export async function retryFailed(app: App): Promise<void> {
  if (app.settings.ownerId === null) return;
  const rows = await app.db
    .prepare("SELECT * FROM messages WHERE status = 'failed' AND direction = 'in' AND created_at > ? ORDER BY id LIMIT ?")
    .bind(app.now() - RETRY_WINDOW, RETRY_BATCH)
    .all();
  for (const row of rows) {
    const stored = toMessage(row);
    if (stored.userMsgId === null) continue;
    const contact = await getContact(app, stored.userId);
    if (!contact) continue;
    try {
      const copied = await copyToDesk(app, contact, { message_id: stored.userMsgId }, null);
      await app.db.prepare("UPDATE messages SET status = 'sent', reason = NULL, desk_chat_id = ?, desk_msg_id = ? WHERE id = ?").bind(copied.chatId, copied.deskMsgId, stored.id).run();
    } catch (error) {
      app.log("warn", "补发失败，下一轮再试", error instanceof Error ? error.message : String(error));
      // 限流和网络问题这一轮都发不了，先停。别的错误只是这一条的事，不能堵住后面的人
      if (!(error instanceof TelegramError) || error.code === 429 || error.code === 0 || error.code >= 500) return;
    }
  }
}

/** 超过补发时限还没送到的消息，告诉主人一声，别让它悄悄消失。 */
async function reportGivenUp(app: App): Promise<void> {
  if (app.settings.ownerId === null) return;
  const row = await app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed' AND direction = 'in' AND created_at <= ?").bind(app.now() - RETRY_WINDOW).first<{ n: unknown }>();
  const count = num(row?.n);
  if (count === 0) return;
  await app.db.prepare("UPDATE messages SET status = 'lost' WHERE status = 'failed' AND direction = 'in' AND created_at <= ?").bind(app.now() - RETRY_WINDOW).run();
  await noticeToOwner(app, `有 ${count} 条消息补发了 24 小时都没送到，已经放弃。在「最近会话」里点对方，「聊天记录」里还能看到内容。`);
}

export async function dailyCleanup(app: App): Promise<void> {
  const today = dayKey(app.now(), app.settings.timezone);
  if (app.settings.lastMaintenanceDay === today) return;
  await saveSetting(app.db, app.settings, "lastMaintenanceDay", today);
  const now = app.now();
  const statements = [
    app.db.prepare("DELETE FROM seen_updates WHERE seen_at < ?").bind(now - 3 * 86_400),
    // 换管理员的空档最长 7 天，这段时间的消息要等得到
    app.db.prepare("DELETE FROM held_messages WHERE held_at < ?").bind(now - 8 * 86_400),
    app.db.prepare("DELETE FROM album_buffer WHERE added_at < ?").bind(app.nowMs() - 3_600_000),
    app.db.prepare("DELETE FROM cards WHERE created_at < ?").bind(now - 400 * 86_400),
  ];
  const days = app.settings.retentionDays;
  if (days > 0) {
    // 到期先抹掉内容，映射留一年，这样还能回复老消息
    statements.push(app.db.prepare("UPDATE messages SET text = NULL, file_id = NULL WHERE created_at < ? AND (text IS NOT NULL OR file_id IS NOT NULL)").bind(now - days * 86_400));
    statements.push(app.db.prepare("DELETE FROM messages WHERE created_at < ?").bind(now - (days + CONTENT_GRACE_DAYS) * 86_400));
  }
  await app.db.batch(statements);
}

export async function tick(app: App): Promise<void> {
  for (const job of [broadcastTick, retryFailed, reportGivenUp, dailyCleanup]) {
    try {
      await job(app);
    } catch (error) {
      app.log("error", "定时任务出错", error instanceof Error ? error.message : String(error));
    }
  }
}
