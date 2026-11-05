// 所有可在 Telegram 里改的配置。默认值要保证「不配置也好用」。
import type { Db } from "./db.ts";
import { str } from "./db.ts";

export type DeskMode = "dm" | "dm_topics" | "group";
export type VerifyMode = "off" | "quiz";

export interface Settings {
  ownerId: number | null;
  deskMode: DeskMode;
  groupId: number | null;
  verifyMode: VerifyMode;
  /** 验证有效天数，0 表示通过一次永久有效 */
  verifyTtlDays: number;
  maxVerifyFailures: number;
  lockMinutes: number;
  welcome: string;
  receiptEnabled: boolean;
  receipt: string;
  offlineEnabled: boolean;
  offlineMessage: string;
  /** 在线时段，24 小时制，如 9 表示 9:00 */
  onlineFrom: number;
  onlineTo: number;
  timezone: string;
  blockedKeywords: string[];
  blockLinksForNew: boolean;
  blockForwards: boolean;
  /** 新联系人第一条消息先进隔离区，人工放行后才转发 */
  reviewNewContacts: boolean;
  messagesPerMinute: number;
  /** 10 分钟内出现这么多新联系人就视为被轰炸 */
  floodThreshold: number;
  floodUntil: number;
  /** 手动解除防护的时间，之前的新联系人不再计入阈值 */
  floodCountFrom: number;
  retentionDays: number;
  /** 认领码（一次性），认领成功或过期后清空 */
  botUsername: string;
  claimCode: string;
  claimExpiresAt: number;
  /** 私聊模式下上一张会话卡片属于谁，换人时要重新发卡片 */
  lastCardUser: number;
  lastMaintenanceDay: string;
}

export const DEFAULT_SETTINGS: Settings = {
  ownerId: null,
  deskMode: "dm",
  groupId: null,
  verifyMode: "quiz",
  verifyTtlDays: 0,
  maxVerifyFailures: 3,
  lockMinutes: 60,
  welcome: "你好，这里是留言通道。\n直接发文字、图片或文件就行，我们看到后会在这里回复你。",
  receiptEnabled: true,
  receipt: "已收到，我们会尽快回复。",
  offlineEnabled: false,
  offlineMessage: "现在不在工作时间，留言我们都会看到，上线后第一时间回复。",
  onlineFrom: 9,
  onlineTo: 22,
  timezone: "Asia/Shanghai",
  blockedKeywords: [],
  blockLinksForNew: true,
  blockForwards: false,
  reviewNewContacts: false,
  messagesPerMinute: 30,
  floodThreshold: 30,
  floodUntil: 0,
  floodCountFrom: 0,
  retentionDays: 180,
  botUsername: "",
  claimCode: "",
  claimExpiresAt: 0,
  lastCardUser: 0,
  lastMaintenanceDay: "",
};

type Key = keyof Settings;

function isKey(key: string): key is Key {
  return Object.hasOwn(DEFAULT_SETTINGS, key);
}

/** 按默认值的形状校验数据库里的值，形状不对就退回默认值，坏数据不能把机器人弄崩。 */
function coerce(key: Key, raw: unknown): Settings[Key] {
  const fallback = DEFAULT_SETTINGS[key];
  if (fallback === null) return typeof raw === "number" ? raw : null;
  if (Array.isArray(fallback)) return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : fallback;
  return typeof raw === typeof fallback && raw !== null ? narrowSetting(raw) : fallback;
}

function narrowSetting(value: unknown): Settings[Key] {
  return value as Settings[Key];
}

export async function loadSettings(db: Db): Promise<Settings> {
  const rows = await db.prepare("SELECT key, value FROM settings").all<{ key: unknown; value: unknown }>();
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const key = str(row.key);
    if (!isKey(key)) continue;
    try {
      merged[key] = coerce(key, JSON.parse(str(row.value)));
    } catch {
      // 单条配置损坏时保留默认值
    }
  }
  return narrowAll(merged);
}

function narrowAll(value: Record<string, unknown>): Settings {
  return value as unknown as Settings;
}

export async function saveSetting<K extends Key>(db: Db, settings: Settings, key: K, value: Settings[K]): Promise<void> {
  settings[key] = value;
  await db
    .prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}
