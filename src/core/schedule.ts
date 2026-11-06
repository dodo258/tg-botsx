// 定时发送：到点把一条文字或图片发给所有联系人。真正发送走群发那套（限流、断点续发、防重复），这里只管什么时候发。
import type { App } from "./app.ts";
import type { Db } from "./db.ts";
import { num, str } from "./db.ts";
import { noticeToOwner } from "./desk.ts";
import { TelegramError } from "./telegram.ts";

export type RepeatKind = "once" | "daily" | "weekly";

export interface Schedule {
  id: number;
  text: string;
  photoId: string;
  hasAsset: boolean;
  repeat: RepeatKind | "draft";
  /** 每天或每周的几个时间，比如 09:00、18:30 */
  times: string[];
  /** 每周的哪几天，0 是周日 */
  weekdays: number[];
  runAt: number;
  enabled: boolean;
  lastRun: number | null;
}

export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 图片说明的上限是 Telegram 定的 */
export const CAPTION_LIMIT = 1024;
export const TEXT_LIMIT = 2000;
/** 服务器停机太久，错过的就不补了：晚上才收到一条「早安」比没收到更糟 */
const LATE_LIMIT = 6 * 3600;

export function toSchedule(row: Record<string, unknown>): Schedule {
  const repeat = str(row.repeat_kind);
  return {
    id: num(row.id),
    text: str(row.text),
    photoId: str(row.photo_id),
    hasAsset: num(row.has_asset) === 1,
    repeat: repeat === "once" || repeat === "daily" || repeat === "weekly" ? repeat : "draft",
    times: str(row.times).split(",").filter(Boolean),
    weekdays: str(row.weekdays).split(",").filter(Boolean).map(Number),
    runAt: num(row.run_at),
    enabled: num(row.enabled) === 1,
    lastRun: typeof row.last_run === "number" ? row.last_run : null,
  };
}

function zoneParts(epoch: number, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(epoch * 1000));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** 某时区的「年月日时分」对应的时间戳。算两遍是为了处理夏令时切换那几天。 */
export function zonedEpoch(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  let guess = wanted;
  for (let round = 0; round < 2; round++) {
    const p = zoneParts(guess, timezone);
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  }
  return guess;
}

/** 严格晚于 after 的下一次发送时间：所有日子和时间里最早的那个。 */
export function nextRun(repeat: "daily" | "weekly", times: string[], weekdays: number[], timezone: string, after: number): number {
  const today = zoneParts(after, timezone);
  let best = Infinity;
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (repeat === "weekly" && !weekdays.includes(date.getUTCDay())) continue;
    for (const time of times) {
      const [hour = 0, minute = 0] = time.split(":").map(Number);
      const epoch = zonedEpoch(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timezone);
      if (epoch > after && epoch < best) best = epoch;
    }
  }
  if (best === Infinity) throw new Error("算不出下一次发送时间");
  return best;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 解析一个或多个时间：9:30 18:00。整理成排好序、不重复的 09:30、18:00。失败返回错误提示。 */
export function parseTimes(input: string): string[] | string {
  const items = input.trim().replace(/：/g, ":").split(/[\s,，、;；]+/).filter(Boolean);
  if (items.length === 0) return "写上时间，比如 9:30。多个时间用空格分开：9:30 18:00。";
  if (items.length > 24) return "一天最多 24 个时间。";
  const times = new Set<string>();
  for (const item of items) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(item);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return `「${item}」不是有效的时间，写成 9:30 这样。多个时间用空格分开。`;
    times.add(`${pad(Number(match[1]))}:${match[2]}`);
  }
  return [...times].sort();
}

/** 解析「只发一次」的时间。支持 9:30、明天 9:30、11-7 9:30、2026-11-07 9:30。失败返回错误提示。 */
export function parseOnce(input: string, timezone: string, now: number): { time: string; runAt: number } | string {
  const text = input.trim().replace(/：/g, ":").replace(/\s+/g, " ");
  const match = /^(?:(明天|(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})) )?(\d{1,2}):(\d{2})$/.exec(text);
  const example = "写成 9:30、明天 9:30 或 11-7 9:30。";
  if (!match) return `时间格式不对，${example}`;
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  if (hour > 23 || minute > 59) return `没有这个时间，${example}`;
  const time = `${pad(hour)}:${pad(minute)}`;
  if (!match[1]) return { time, runAt: nextRun("daily", [time], [], timezone, now) };
  const today = zoneParts(now, timezone);
  let year = today.year;
  let month = today.month;
  let day = today.day + 1;
  if (match[1] !== "明天") {
    month = Number(match[3]);
    day = Number(match[4]);
    year = match[2] ? Number(match[2]) : year;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return `没有这一天，${example}`;
  } else {
    const tomorrow = new Date(Date.UTC(year, month - 1, day));
    year = tomorrow.getUTCFullYear();
    month = tomorrow.getUTCMonth() + 1;
    day = tomorrow.getUTCDate();
  }
  let runAt = zonedEpoch(year, month, day, hour, minute, timezone);
  // 没写年份的日期已经过了，就是明年的这一天
  if (runAt <= now && !match[2] && match[1] !== "明天") runAt = zonedEpoch(year + 1, month, day, hour, minute, timezone);
  if (runAt <= now) return "这个时间已经过了，换一个。";
  return { time, runAt };
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function describeRepeat(schedule: Schedule, timezone: string): string {
  const times = schedule.times.join("、");
  if (schedule.repeat === "daily") return `每天 ${times}`;
  if (schedule.repeat === "weekly") {
    const days = WEEK_ORDER.filter((day) => schedule.weekdays.includes(day)).map((day) => (WEEKDAYS[day] ?? "").slice(1));
    return `每周${days.join("、")} ${times}`;
  }
  return `${formatWhen(schedule.runAt, timezone)} 发一次`;
}

export function formatWhen(epoch: number, timezone: string): string {
  const p = zoneParts(epoch, timezone);
  return `${p.month} 月 ${p.day} 日 ${pad(p.hour)}:${pad(p.minute)}`;
}

export function scheduleState(schedule: Schedule, timezone: string): string {
  if (schedule.enabled) return `下次 ${formatWhen(schedule.runAt, timezone)}`;
  if (schedule.repeat === "once" && schedule.lastRun !== null) return "已发送";
  return "已暂停";
}

export async function countRecipients(db: Db, ownerId: number | null): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE blocked_at IS NULL AND unreachable_at IS NULL AND msg_count > 0 AND user_id != ?").bind(ownerId ?? 0).first<{ n: unknown }>();
  return num(row?.n);
}

export async function listSchedules(db: Db): Promise<Schedule[]> {
  const rows = await db.prepare("SELECT * FROM schedules WHERE repeat_kind != 'draft' ORDER BY enabled DESC, run_at, id LIMIT 50").all();
  return rows.map(toSchedule);
}

export async function getSchedule(db: Db, id: number): Promise<Schedule | null> {
  const row = await db.prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first();
  return row ? toSchedule(row) : null;
}

/** 先存内容，时间后面再问。没选完的是草稿，不会发送。 */
export async function createDraft(db: Db, content: { text: string; photoId?: string; asset?: { mime: string; data: string } }, now: number): Promise<number> {
  const row = await db
    .prepare("INSERT INTO schedules(text, photo_id, has_asset, created_at) VALUES(?, ?, ?, ?) RETURNING id")
    .bind(content.text, content.photoId ?? "", content.asset ? 1 : 0, now)
    .first<{ id: unknown }>();
  const id = num(row?.id);
  if (content.asset) await db.prepare("INSERT INTO assets(name, mime, data) VALUES(?, ?, ?)").bind(`schedule:${id}`, content.asset.mime, content.asset.data).run();
  return id;
}

export async function activateSchedule(db: Db, id: number, plan: { repeat: "daily" | "weekly"; times: string[]; weekdays: number[] } | { repeat: "once"; time: string; runAt: number }, timezone: string, now: number): Promise<void> {
  const once = plan.repeat === "once";
  const times = once ? [plan.time] : plan.times;
  const weekdays = once ? [] : plan.weekdays;
  const runAt = once ? plan.runAt : nextRun(plan.repeat, times, weekdays, timezone, now);
  await db.prepare("UPDATE schedules SET repeat_kind = ?, times = ?, weekdays = ?, run_at = ?, enabled = 1 WHERE id = ?").bind(plan.repeat, times.join(","), weekdays.join(","), runAt, id).run();
}

/** 暂停或恢复。恢复时从现在算下一次，暂停期间错过的不补。返回错误提示。 */
export async function toggleSchedule(db: Db, schedule: Schedule, timezone: string, now: number): Promise<string | null> {
  if (schedule.enabled) {
    await db.prepare("UPDATE schedules SET enabled = 0 WHERE id = ?").bind(schedule.id).run();
    return null;
  }
  if (schedule.repeat === "once") {
    if (schedule.lastRun !== null) return "这条已经发过了。";
    if (schedule.runAt <= now) return "这条的时间已经过了，删掉重新建一条。";
    await db.prepare("UPDATE schedules SET enabled = 1 WHERE id = ?").bind(schedule.id).run();
    return null;
  }
  if (schedule.repeat === "draft") return "这条还没设好时间。";
  const runAt = nextRun(schedule.repeat, schedule.times, schedule.weekdays, timezone, now);
  await db.prepare("UPDATE schedules SET enabled = 1, run_at = ? WHERE id = ?").bind(runAt, schedule.id).run();
  return null;
}

/** 删除时正在发的也停掉：删了还继续发，人会以为出了问题。 */
export async function deleteSchedule(db: Db, id: number, now: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE broadcasts SET state = 'cancelled', finished_at = ? WHERE schedule_id = ? AND state = 'running'").bind(now, id),
    db.prepare("DELETE FROM assets WHERE name = ?").bind(`schedule:${id}`),
    db.prepare("DELETE FROM schedules WHERE id = ?").bind(id),
  ]);
}

/** 到点的变成一次群发。建群发和算下一次在同一个事务里，进程被杀也不会发两遍或漏掉。 */
export async function scheduleTick(app: App): Promise<void> {
  const row = await app.db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND run_at <= ? ORDER BY run_at, id LIMIT 1").bind(app.now()).first();
  if (!row) return;
  const schedule = toSchedule(row);
  if (schedule.repeat === "draft") return;
  const now = app.now();
  const late = now - schedule.runAt > LATE_LIMIT;
  // 还有群发在跑就等它结束，下一轮再来。两个一起发容易被 Telegram 限流
  if (!late) {
    const running = await app.db.prepare("SELECT id FROM broadcasts WHERE state = 'running' LIMIT 1").first();
    if (running) return;
  }
  const next = schedule.repeat === "once" ? schedule.runAt : nextRun(schedule.repeat, schedule.times, schedule.weekdays, app.settings.timezone, now);
  const enabled = schedule.repeat === "once" ? 0 : 1;
  const advance = app.db.prepare("UPDATE schedules SET run_at = ?, enabled = ?, last_run = ? WHERE id = ?");
  if (late) {
    await advance.bind(next, enabled, schedule.lastRun, schedule.id).run();
    await noticeToOwner(app, `定时发送错过了时间（服务器停机太久），这次没有发：\n${describeRepeat(schedule, app.settings.timezone)}`).catch((error: unknown) => {
      app.log("warn", "通知错过定时发送失败", error instanceof Error ? error.message : String(error));
    });
    return;
  }
  const total = await countRecipients(app.db, app.settings.ownerId);
  await app.db.batch([
    app.db.prepare("INSERT INTO broadcasts(from_chat_id, from_msg_id, report_chat_id, total, created_at, state, schedule_id) VALUES(0, 0, ?, ?, ?, 'running', ?)").bind(app.settings.ownerId ?? 0, total, now, schedule.id),
    advance.bind(next, enabled, now, schedule.id),
  ]);
}

/** 发给一个人。网页上传的图片第一次要真的传上去，之后用 Telegram 的文件编号。 */
export async function sendScheduled(app: App, schedule: Schedule, userId: number): Promise<void> {
  const caption = schedule.text ? { caption: schedule.text } : {};
  if (schedule.photoId) {
    await app.tg.call("sendPhoto", { chat_id: userId, photo: schedule.photoId, ...caption });
    return;
  }
  if (schedule.hasAsset) {
    const asset = await app.db.prepare("SELECT mime, data FROM assets WHERE name = ?").bind(`schedule:${schedule.id}`).first<{ mime: unknown; data: unknown }>();
    if (!asset) throw new TelegramError("sendPhoto", 400, "Bad Request: 定时发送的图片不见了", null);
    const bytes = new Uint8Array(Buffer.from(str(asset.data), "base64"));
    const sent = await app.tg.upload<{ photo?: { file_id: string }[] }>("sendPhoto", { chat_id: userId, ...caption }, "photo", bytes, `schedule.${str(asset.mime).split("/")[1] ?? "jpg"}`, str(asset.mime));
    const fileId = sent.photo?.at(-1)?.file_id;
    if (fileId) {
      await app.db.prepare("UPDATE schedules SET photo_id = ? WHERE id = ?").bind(fileId, schedule.id).run();
      schedule.photoId = fileId;
    }
    return;
  }
  await app.tg.call("sendMessage", { chat_id: userId, text: schedule.text });
}
