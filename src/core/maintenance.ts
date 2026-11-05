// 定时任务：群发、补发失败的消息、每日清理、Webhook 自检。
// Worker 每分钟跑一次，Node 每 20 秒跑一次。每次只干一小批，不超出免费版每次调用 50 个子请求的限制。
import type { App } from "./app.ts";
import { dayKey, getContact } from "./contacts.ts";
import { num, str } from "./db.ts";
import { copyToDesk, noticeToOwner } from "./desk.ts";
import { toMessage } from "./messages.ts";
import { registerWebhook } from "./setup.ts";
import { saveSetting } from "./settings.ts";
import { TelegramError } from "./telegram.ts";

const BROADCAST_BATCH = 25;
const RETRY_BATCH = 8;
const RETRY_WINDOW = 24 * 3600;
const WEBHOOK_ALERT_INTERVAL = 6 * 3600;
const CONTENT_GRACE_DAYS = 365;

export async function broadcastTick(app: App): Promise<void> {
  const job = await app.db.prepare("SELECT * FROM broadcasts WHERE state = 'running' ORDER BY id LIMIT 1").first();
  if (!job) return;
  const id = num(job.id);
  const fromChat = num(job.from_chat_id);
  const fromMsg = num(job.from_msg_id);
  let cursor = num(job.cursor);
  const recipients = await app.db
    .prepare("SELECT user_id FROM contacts WHERE user_id > ? AND blocked_at IS NULL AND unreachable_at IS NULL AND msg_count > 0 AND user_id != ? ORDER BY user_id LIMIT ?")
    .bind(cursor, app.settings.ownerId ?? 0, BROADCAST_BATCH)
    .all<{ user_id: unknown }>();
  if (recipients.length === 0) {
    await app.db.prepare("UPDATE broadcasts SET state = 'done', finished_at = ? WHERE id = ?").bind(app.now(), id).run();
    await app.tg.call("sendMessage", { chat_id: num(job.report_chat_id), text: `群发完成：成功 ${num(job.sent)}，失败 ${num(job.failed)}。` });
    return;
  }
  let sent = 0;
  let failed = 0;
  const unreachable: number[] = [];
  for (const recipient of recipients) {
    const userId = num(recipient.user_id);
    try {
      await app.tg.call("copyMessage", { chat_id: userId, from_chat_id: fromChat, message_id: fromMsg });
      sent++;
    } catch (error) {
      // 被限流就停在这一个，下一轮从这里继续
      if (error instanceof TelegramError && error.code === 429) break;
      failed++;
      if (error instanceof TelegramError && error.userUnreachable) unreachable.push(userId);
    }
    cursor = userId;
  }
  await app.db.batch([
    app.db.prepare("UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ? WHERE id = ?").bind(cursor, sent, failed, id),
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
      return;
    }
  }
}

export async function dailyCleanup(app: App): Promise<void> {
  const today = dayKey(app.now(), app.settings.timezone);
  if (app.settings.lastMaintenanceDay === today) return;
  await saveSetting(app.db, app.settings, "lastMaintenanceDay", today);
  const now = app.now();
  const statements = [
    app.db.prepare("DELETE FROM seen_updates WHERE seen_at < ?").bind(now - 3 * 86_400),
    app.db.prepare("DELETE FROM held_messages WHERE held_at < ?").bind(now - 86_400),
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

/** Webhook 被改掉就改回来；一直出错就提醒主人，6 小时最多一次。 */
export async function checkWebhook(app: App, token: string): Promise<void> {
  const expected = app.settings.webhookUrl;
  if (!expected || app.settings.ownerId === null) return;
  const info = await app.tg.call<{ url?: string; last_error_date?: number; last_error_message?: string; pending_update_count?: number }>("getWebhookInfo");
  if (info.url !== expected) {
    app.log("warn", "Webhook 地址不对，已自动改回", info.url ?? "");
    await registerWebhook(app, token, expected);
    return;
  }
  const lastError = info.last_error_date ?? 0;
  if (app.now() - lastError > 600) return;
  if (app.now() - app.settings.lastWebhookAlertAt < WEBHOOK_ALERT_INTERVAL) return;
  await saveSetting(app.db, app.settings, "lastWebhookAlertAt", app.now());
  await noticeToOwner(app, `Webhook 最近投递出错：${str(info.last_error_message)}\n待处理更新 ${info.pending_update_count ?? 0} 条。`);
}

export async function tick(app: App, options: { webhookToken?: string; minute: number }): Promise<void> {
  const jobs: (() => Promise<void>)[] = [() => broadcastTick(app), () => retryFailed(app), () => dailyCleanup(app)];
  if (options.webhookToken !== undefined && options.minute % 10 === 0) {
    const token = options.webhookToken;
    jobs.push(() => checkWebhook(app, token));
  }
  for (const job of jobs) {
    try {
      await job();
    } catch (error) {
      app.log("error", "定时任务出错", error instanceof Error ? error.message : String(error));
    }
  }
}
