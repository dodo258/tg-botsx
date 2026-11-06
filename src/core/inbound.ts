// 联系人消息流水线：屏蔽 → 防轰炸 → 验证 → 限流 → 拦截 → 转发 → 自动回复。
// 顺序有讲究：越靠前越便宜，骚扰消息尽早返回，不耗 API 额度。
import type { Message, User } from "@grammyjs/types";
import { bufferAlbum } from "./album.ts";
import type { App } from "./app.ts";
import type { Contact } from "./contacts.ts";
import { bumpDaily, getContact, identityHtml, touchContact } from "./contacts.ts";
import { num, str } from "./db.ts";
import { contactKeyboard, copyToDesk, noticeToOwner } from "./desk.ts";
import { evaluate } from "./filter.ts";
import { clipHtml, describe } from "./message-info.ts";
import type { MessageInfo } from "./message-info.ts";
import { findByUserMsg, insertMessage } from "./messages.ts";
import { saveSetting } from "./settings.ts";
import { TelegramError } from "./telegram.ts";
import { reactOk } from "./outbound.ts";
import { makeChallenge } from "./verify.ts";

const CHALLENGE_TTL = 5 * 60;
const MAX_HELD = 30;
const AUTO_REPLY_COOLDOWN = 4 * 60 * 60;
const FLOOD_WINDOW = 10 * 60;
const FLOOD_GUARD = 30 * 60;
const MUTE_SECONDS = 10 * 60;
const NEW_CONTACT_MESSAGES = 3;

export function needsVerification(app: App, contact: Contact): boolean {
  if (app.settings.verifyMode === "off" || contact.verifyExempt) return false;
  if (contact.verifiedAt === null) return true;
  const ttlDays = app.settings.verifyTtlDays;
  return ttlDays > 0 && app.now() - contact.verifiedAt > ttlDays * 86_400;
}

export function challengePending(app: App, contact: Contact): boolean {
  return contact.challengeId !== null && contact.challengeAt !== null && app.now() - contact.challengeAt <= CHALLENGE_TTL;
}

export async function sendChallenge(app: App, contact: Contact, prefix = "发消息前先答一道题，确认你不是机器人。"): Promise<void> {
  const challenge = makeChallenge(app.rng);
  const challengeId = app.rng.token();
  let correctToken = "";
  const buttons = challenge.options.map((label) => {
    const token = app.rng.token();
    if (label === challenge.correct) correctToken = token;
    return { text: label, callback_data: `v:${challengeId}:${token}` };
  });
  await app.db
    .prepare("UPDATE contacts SET challenge_id = ?, challenge_token = ?, challenge_at = ? WHERE user_id = ?")
    .bind(challengeId, correctToken, app.now(), contact.userId)
    .run();
  const rows: { text: string; callback_data: string }[][] = [];
  for (let index = 0; index < buttons.length; index += 3) rows.push(buttons.slice(index, index + 3));
  rows.push([{ text: "换一题", callback_data: `vr:${challengeId}` }]);
  await app.tg.call("sendMessage", { chat_id: contact.userId, text: `${prefix}\n\n${challenge.question}`, reply_markup: { inline_keyboard: rows } });
}

async function holdForVerification(app: App, contact: Contact, message: Message, info: MessageInfo): Promise<void> {
  const count = await app.db.prepare("SELECT COUNT(*) AS n FROM held_messages WHERE user_id = ?").bind(contact.userId).first<{ n: unknown }>();
  if (num(count?.n) >= MAX_HELD) return;
  // 拦截判断要用原始消息（链接实体、转发来源），这些只有现在拿得到，所以先判断，结果存下来
  const verdict = evaluate(message, app.settings, contact.msgCount < NEW_CONTACT_MESSAGES);
  await app.db
    .prepare("INSERT OR IGNORE INTO held_messages(user_id, message_id, kind, text, file_id, reason, held_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
    .bind(contact.userId, message.message_id, info.kind, info.text || null, info.fileId || null, verdict.action === "hold" ? verdict.reason : null, app.now())
    .run();
}

/** 进隔离区，不转发。新联系人待审核时通知主人一次。 */
async function quarantine(app: App, contact: Contact, userMsgId: number, info: MessageInfo, filterReason: string | null): Promise<void> {
  const reason = filterReason ?? "新联系人待审核";
  await app.db.batch([
    insertMessage(app, { userId: contact.userId, direction: "in", kind: info.kind, text: info.text, fileId: info.fileId, userMsgId, deskChatId: null, deskMsgId: null, staffId: null, status: "filtered", reason }),
    bumpDaily(app, "filtered"),
  ]);
  if (filterReason !== null || contact.msgCount > 0) return;
  // 消息已经入库。通知只是提醒，失败不能让调用方以为这条没处理，否则会重复入库
  await noticeToOwner(app, `新联系人待审核：\n${identityHtml(contact)}\n\n${clipHtml(info.text, 300)}`, {
    inline_keyboard: [[{ text: "放行", callback_data: `approve:${contact.userId}` }, { text: "屏蔽", callback_data: `block:${contact.userId}` }]],
  }).catch((error: unknown) => {
    app.log("warn", "发送待审核通知失败", error instanceof Error ? error.message : String(error));
  });
  await app.db.prepare("UPDATE contacts SET msg_count = msg_count + 1 WHERE user_id = ?").bind(contact.userId).run();
  contact.msgCount += 1;
}

function needsReview(app: App, contact: Contact): boolean {
  return app.settings.reviewNewContacts && contact.approvedAt === null;
}

/** 验证通过后处理验证前留下的消息：该拦的进隔离区，其余补发给客服台。 */
export async function releaseHeld(app: App, contact: Contact): Promise<void> {
  const rows = await app.db.prepare("SELECT * FROM held_messages WHERE user_id = ? ORDER BY message_id").bind(contact.userId).all();
  for (const row of rows) {
    const info: MessageInfo = { kind: typeof row.kind === "string" ? row.kind : "other", text: typeof row.text === "string" ? row.text : "", fileId: typeof row.file_id === "string" ? row.file_id : "" };
    const filterReason = typeof row.reason === "string" ? row.reason : null;
    const userMsgId = num(row.message_id);
    if (filterReason !== null || needsReview(app, contact)) await quarantine(app, contact, userMsgId, info, filterReason);
    else await deliver(app, contact, { message_id: userMsgId }, info, null);
    // 转完一条删一条：deliver 失败会记成待补发，这里抛错时没转的留着下次再转
    await app.db.prepare("DELETE FROM held_messages WHERE user_id = ? AND message_id = ?").bind(contact.userId, userMsgId).run();
  }
}

/** Telegram 的图片说明最长 1024 字，超了分两条发 */
const CAPTION_LIMIT = 1024;

/**
 * 第一次的自动回复，可以带一张图片。发过之后不再发文字回执，后面只打 👌。
 * 图片发不出去（比如换过 Token，旧文件编号失效）时退回只发文字，不能让人收不到回复。
 */
async function sendWelcome(app: App, contact: Contact): Promise<void> {
  const text = app.settings.welcome;
  const chat = contact.userId;
  await app.db.prepare("UPDATE contacts SET last_receipt_at = ? WHERE user_id = ?").bind(app.now(), chat).run();
  const fits = text.length <= CAPTION_LIMIT;
  const caption = fits && text ? { caption: text } : {};
  let photoSent = false;
  if (app.settings.welcomeImage) {
    try {
      if (app.settings.welcomePhotoId) {
        await app.tg.call("sendPhoto", { chat_id: chat, photo: app.settings.welcomePhotoId, ...caption });
        photoSent = true;
      } else {
        const asset = await app.db.prepare("SELECT mime, data FROM assets WHERE name = 'welcome'").first<{ mime: unknown; data: unknown }>();
        if (asset) {
          const bytes = new Uint8Array(Buffer.from(str(asset.data), "base64"));
          const sent = await app.tg.upload<{ photo?: { file_id: string }[] }>("sendPhoto", { chat_id: chat, ...caption }, "photo", bytes, "welcome", str(asset.mime));
          photoSent = true;
          // 记下文件编号，之后不用每次都上传
          const fileId = sent.photo?.at(-1)?.file_id;
          if (fileId) await saveSetting(app.db, app.settings, "welcomePhotoId", fileId);
        }
      }
    } catch (error) {
      if (error instanceof TelegramError && error.userUnreachable) throw error;
      app.log("warn", "自动回复的图片发送失败，改发文字", error instanceof Error ? error.message : String(error));
      await saveSetting(app.db, app.settings, "welcomePhotoId", "");
      const asset = await app.db.prepare("SELECT name FROM assets WHERE name = 'welcome'").first();
      if (!asset) await saveSetting(app.db, app.settings, "welcomeImage", false);
    }
  }
  if (text && (!photoSent || !fits)) await app.tg.call("sendMessage", { chat_id: chat, text });
}

/** 有管理员了，把空档期间存下的消息转过去。还没通过验证的人继续等验证。 */
export async function releaseAllHeld(app: App): Promise<void> {
  const rows = await app.db.prepare("SELECT DISTINCT user_id FROM held_messages").all<{ user_id: unknown }>();
  for (const row of rows) {
    const contact = await getContact(app, num(row.user_id));
    if (!contact || contact.blockedAt !== null) continue;
    // 一个人出错不能挡住后面的人
    try {
      if (!needsVerification(app, contact)) await releaseHeld(app, contact);
      else if (!challengePending(app, contact)) await sendChallenge(app, contact, "这边设置好了。答完这道题，刚才的消息就转过去。");
    } catch (error) {
      app.log("warn", `转发 ${contact.userId} 暂存的消息失败`, error instanceof Error ? error.message : String(error));
    }
  }
}

/** 把消息送到客服台并记账。送不到就记为 failed，由定时任务补发，并告诉对方消息没丢。 */
export async function deliver(app: App, contact: Contact, message: Pick<Message, "message_id">, info: MessageInfo, quoteId: number | null): Promise<boolean> {
  const now = app.now();
  const counters = app.db
    .prepare("UPDATE contacts SET msg_count = msg_count + 1, unread = unread + 1, first_unread_at = COALESCE(first_unread_at, ?), last_inbound_at = ? WHERE user_id = ?")
    .bind(now, now, contact.userId);
  try {
    const copied = await copyToDesk(app, contact, message, quoteId);
    await app.db.batch([
      insertMessage(app, { userId: contact.userId, direction: "in", kind: info.kind, text: info.text, fileId: info.fileId, userMsgId: message.message_id, deskChatId: copied.chatId, deskMsgId: copied.deskMsgId, staffId: null, status: "sent" }),
      counters,
      bumpDaily(app, "inbound"),
    ]);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    app.log("error", `消息转发失败（联系人 ${contact.userId}），稍后补发`, reason);
    await app.db.batch([
      insertMessage(app, { userId: contact.userId, direction: "in", kind: info.kind, text: info.text, fileId: info.fileId, userMsgId: message.message_id, deskChatId: null, deskMsgId: null, staffId: null, status: "failed", reason }),
      counters,
      bumpDaily(app, "inbound"),
    ]);
    return false;
  }
}

/** 新联系人突增时开启防轰炸。返回 true 表示当前处于防护期，且这个联系人应被静默丢弃。 */
async function floodBlocked(app: App, contact: Contact, isNew: boolean): Promise<boolean> {
  const stranger = contact.verifiedAt === null && !contact.verifyExempt && contact.msgCount === 0;
  if (app.settings.floodUntil > app.now()) return stranger;
  if (!isNew) return false;
  const row = await app.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE first_seen > ?").bind(Math.max(app.now() - FLOOD_WINDOW, app.settings.floodCountFrom)).first<{ n: unknown }>();
  if (num(row?.n) < app.settings.floodThreshold) return false;
  await saveSetting(app.db, app.settings, "floodUntil", app.now() + FLOOD_GUARD);
  await noticeToOwner(app, `10 分钟内新增 ${num(row?.n)} 个陌生联系人，疑似被轰炸。\n接下来 30 分钟陌生人的消息不处理，已验证的联系人不受影响。`, { inline_keyboard: [[{ text: "解除防护", callback_data: "flood_off" }]] });
  return true;
}

function isOffline(app: App): boolean {
  if (!app.settings.offlineEnabled) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: app.settings.timezone, hour: "2-digit", hour12: false }).format(new Date(app.now() * 1000))) % 24;
  const { onlineFrom: from, onlineTo: to } = app.settings;
  const online = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  return !online;
}

/** 关键词自动回复。返回是否命中。 */
async function keywordReply(app: App, contact: Contact, text: string): Promise<boolean> {
  if (!text) return false;
  const rules = await app.db.prepare("SELECT id, keywords, reply FROM auto_rules ORDER BY id LIMIT 200").all<{ id: unknown; keywords: unknown; reply: unknown }>();
  const lowered = text.toLowerCase();
  for (const rule of rules) {
    if (typeof rule.keywords !== "string" || typeof rule.reply !== "string") continue;
    const words = rule.keywords.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
    if (!words.some((word) => lowered.includes(word))) continue;
    const sent = await app.tg.call<{ message_id: number }>("sendMessage", { chat_id: contact.userId, text: rule.reply });
    await app.db.batch([
      app.db.prepare("UPDATE auto_rules SET hits = hits + 1 WHERE id = ?").bind(num(rule.id)),
      insertMessage(app, { userId: contact.userId, direction: "out", kind: "text", text: `[自动回复] ${rule.reply}`, fileId: "", userMsgId: sent.message_id, deskChatId: null, deskMsgId: null, staffId: null, status: "sent" }),
    ]);
    return true;
  }
  return false;
}

// 每条消息都回文字，对方会嫌烦。送达靠消息上的 👌，文字回执只在第一次和隔了很久再来时发
const RECEIPT_COOLDOWN = 30 * 86_400;

async function autoReply(app: App, contact: Contact, text: string, delivered: boolean): Promise<void> {
  const now = app.now();
  if (!delivered) {
    await app.tg.call("sendMessage", { chat_id: contact.userId, text: "消息已保存，正在重新投递，请不用重发。" });
    return;
  }
  if (await keywordReply(app, contact, text)) return;
  if (isOffline(app)) {
    if (contact.lastOfflineAt !== null && now - contact.lastOfflineAt < AUTO_REPLY_COOLDOWN) return;
    await app.tg.call("sendMessage", { chat_id: contact.userId, text: app.settings.offlineMessage });
    await app.db.prepare("UPDATE contacts SET last_offline_at = ? WHERE user_id = ?").bind(now, contact.userId).run();
    return;
  }
  if (!app.settings.receiptEnabled || contact.unread > 0) return;
  if (contact.lastReceiptAt !== null && now - contact.lastReceiptAt < RECEIPT_COOLDOWN) return;
  await app.tg.call("sendMessage", { chat_id: contact.userId, text: app.settings.receipt });
  await app.db.prepare("UPDATE contacts SET last_receipt_at = ? WHERE user_id = ?").bind(now, contact.userId).run();
}

async function consumeRate(app: App, contact: Contact): Promise<boolean> {
  const window = Math.floor(app.now() / 60);
  const count = contact.rateWindow === window ? contact.rateCount + 1 : 1;
  if (count > app.settings.messagesPerMinute) {
    await app.db.prepare("UPDATE contacts SET muted_until = ?, rate_window = ?, rate_count = ? WHERE user_id = ?").bind(app.now() + MUTE_SECONDS, window, count, contact.userId).run();
    await app.tg.call("sendMessage", { chat_id: contact.userId, text: `发得太快了，先歇 10 分钟。这段时间发的消息不会转达。` });
    await noticeToOwner(app, `${identityHtml(contact)}\n一分钟内发了 ${count} 条，已暂停接收 10 分钟。`, contactKeyboard(contact, false, true));
    return false;
  }
  await app.db.prepare("UPDATE contacts SET rate_window = ?, rate_count = ? WHERE user_id = ?").bind(window, count, contact.userId).run();
  return true;
}

function startPayload(text: string | undefined): boolean {
  return text !== undefined && /^\/start(@\w+)?(\s|$)/.test(text);
}

export async function handleContactMessage(app: App, message: Message, user: User): Promise<void> {
  const { contact, isNew } = await touchContact(app, user);
  if (isNew) await bumpDaily(app, "new_contacts").run();
  const isStart = startPayload(message.text);
  if (app.settings.ownerId === null) {
    // 换管理员的空档里客户的消息不能丢：先存着，有人绑定后转过去
    if (isStart) {
      await app.tg.call("sendMessage", { chat_id: user.id, text: "这个机器人还在设置中，发的消息会先存着，设置好后转过去。" });
    } else if (contact.blockedAt === null) {
      const held = await app.db.prepare("SELECT COUNT(*) AS n FROM held_messages WHERE user_id = ?").bind(user.id).first<{ n: unknown }>();
      await holdForVerification(app, contact, message, describe(message));
      if (num(held?.n) === 0) await app.tg.call("sendMessage", { chat_id: user.id, text: "消息已保存，这边设置好后会转过去，不用重发。" });
    }
    return;
  }
  if (contact.blockedAt !== null) return;
  if (await floodBlocked(app, contact, isNew)) return;
  if (contact.mutedUntil !== null && contact.mutedUntil > app.now()) return;

  const info = describe(message);
  if (needsVerification(app, contact)) {
    if (contact.lockedUntil !== null && contact.lockedUntil > app.now()) {
      if (isStart) await app.tg.call("sendMessage", { chat_id: user.id, text: "验证失败次数太多，请过一会儿再试。" });
      return;
    }
    if (!isStart) await holdForVerification(app, contact, message, info);
    // 对方清空聊天后点开始，旧题已经看不到了，要重发
    if (!challengePending(app, contact) || isStart) {
      if (isStart) await sendWelcome(app, contact);
      await sendChallenge(app, contact);
    }
    return;
  }
  // 关掉验证或设成免验证后，之前暂存的消息要转过去
  await releaseHeld(app, contact);
  if (isStart) {
    await sendWelcome(app, contact);
    return;
  }
  if (!(await consumeRate(app, contact))) return;

  const isNewContact = contact.msgCount < NEW_CONTACT_MESSAGES;
  const verdict = evaluate(message, app.settings, isNewContact);
  if (verdict.action === "hold" || needsReview(app, contact)) {
    await quarantine(app, contact, message.message_id, info, verdict.action === "hold" ? verdict.reason : null);
    return;
  }

  if (message.media_group_id) {
    await bufferAlbum(app, { message, info, groupId: message.media_group_id, direction: "in", userId: user.id, staffId: null });
    if (app.settings.receiptEnabled) await reactOk(app, message, "👌");
    return;
  }

  let quoteId: number | null = null;
  if (message.reply_to_message) {
    const quoted = await findByUserMsg(app, user.id, message.reply_to_message.message_id);
    quoteId = quoted?.deskMsgId ?? null;
  }
  const delivered = await deliver(app, contact, message, info, quoteId);
  if (delivered && app.settings.receiptEnabled) await reactOk(app, message, "👌");
  try {
    await autoReply(app, contact, info.text, delivered);
  } catch (error) {
    // 自动回复失败不影响消息本身已送达
    if (error instanceof TelegramError && error.userUnreachable) return;
    app.log("warn", "自动回复发送失败", error instanceof Error ? error.message : String(error));
  }
}
