// /settings 菜单：所有配置都在 Telegram 里改，不需要网页后台，也不用重新部署。
import type { Message } from "@grammyjs/types";
import type { App } from "./app.ts";
import { num, str } from "./db.ts";
import { clipChars, clipHtml, escapeHtml } from "./message-info.ts";
import type { Settings } from "./settings.ts";
import { saveSetting } from "./settings.ts";

type Button = { text: string; callback_data: string } | { text: string; url: string };
export interface Menu {
  text: string;
  keyboard: { inline_keyboard: Button[][] };
}

const onOff = (value: boolean) => (value ? "开" : "关");
const BACK: Button[] = [{ text: "⬅️ 返回设置", callback_data: "m:main" }];
const toggle = (on: boolean, label: string) => `${on ? "✅" : "⬜️"} ${label}`;

export const backRow = () => [{ text: "🏠 返回首页", callback_data: "p:main" }];
export const CANCEL_KEYBOARD = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel" }]] };

/** 面板首页：只放每天都用的，计数写在按钮上，一眼看到哪里有事。不常用的收进「更多」。 */
export async function renderPanel(app: App, owner: boolean, staffId?: number): Promise<Menu> {
  const counts = await app.db
    .prepare("SELECT (SELECT COUNT(*) FROM contacts WHERE unread > 0) AS unread, (SELECT COUNT(*) FROM messages WHERE status = 'filtered') AS filtered")
    .first<{ unread: unknown; filtered: unknown }>();
  const unread = num(counts?.unread);
  const filtered = num(counts?.filtered);
  // 选中的人写在最上面，翻聊天记录找不到当时那张卡片时也能看到现在在回谁
  const selected = staffId === undefined || app.settings.deskMode === "group" ? null : await app.db.prepare("SELECT c.user_id AS id, c.first_name AS name FROM staff_state s JOIN contacts c ON c.user_id = s.selected_user_id WHERE s.staff_id = ?").bind(staffId).first<{ id: unknown; name: unknown }>();
  const rows: Button[][] = [
    ...(selected ? [[{ text: clipChars(`✍️ 正在回复：${str(selected.name)}`, 40), callback_data: `open:${num(selected.id)}` }]] : []),
    [{ text: unread > 0 ? `💬 最近会话（${unread} 人未读）` : "💬 最近会话", callback_data: "list:0" }, { text: "🔍 搜索联系人", callback_data: "srch" }],
    [{ text: "⚡️ 快捷回复", callback_data: "qm:0" }, { text: filtered > 0 ? `🛡 隔离区（${filtered}）` : "🛡 隔离区", callback_data: "filtered:0" }],
  ];
  if (owner) {
    rows.push(
      [{ text: "📢 群发", callback_data: "bc" }, { text: "⏰ 定时发送", callback_data: "sch" }],
      [{ text: "📊 统计", callback_data: "p:stats" }, { text: "⚙️ 设置", callback_data: "m:main" }],
      [{ text: "📂 更多", callback_data: "p:more" }],
    );
  } else {
    // 同事的「更多」里只会剩一个，不值得多点一下
    rows.push([{ text: "🚫 已屏蔽", callback_data: "bk:0" }, { text: "📊 统计", callback_data: "p:stats" }]);
  }
  rows.push([{ text: "❓ 怎么回复消息", callback_data: "p:help" }]);
  return {
    text: "<b>🏠 管理面板</b>\n点下面的按钮操作。\n\n回复别人：长按转来的消息点「回复」；消息被顶上去了，就从「最近会话」里找到他。对方看不到你的账号。",
    keyboard: { inline_keyboard: rows },
  };
}

export function renderMore(): Menu {
  return {
    text: "<b>📂 更多</b>",
    keyboard: {
      inline_keyboard: [
        [{ text: "🤖 关键词回复", callback_data: "rl:0" }, { text: "🚫 已屏蔽", callback_data: "bk:0" }],
        [{ text: "🧹 清理记录", callback_data: "cl" }, { text: "📦 导出数据", callback_data: "ex" }],
        [{ text: "🟢 运行状态", callback_data: "p:status" }],
        backRow(),
      ],
    },
  };
}

export function deskModeLabel(settings: Settings): string {
  if (settings.deskMode === "group") return "话题群（可多人协作）";
  if (settings.deskMode === "dm_topics") return "私聊话题（实验）";
  return "私聊卡片";
}

export function renderMenu(app: App, page: string): Menu {
  const s = app.settings;
  switch (page) {
    case "desk":
      return {
        text:
          `<b>📥 消息收在哪</b>\n当前：${deskModeLabel(s)}\n\n` +
          "<b>私聊卡片</b>：什么都不用配，消息都到你和机器人的私聊里。\n" +
          "<b>话题群</b>：每个联系人一个话题，可以拉同事一起回复。先建一个开了话题的超级群，再点下面的按钮选这个群，给机器人管理员权限后会自动绑定。没有自动绑定的话，在群里发 /bindgroup。\n" +
          "<b>私聊话题</b>：不用建群也有话题，需要先在 @BotFather 的 Mini App 里打开话题模式。这个开关是机器人全局的，普通用户的聊天界面也可能变化，所以算实验功能。",
        keyboard: {
          inline_keyboard: [
            [{ text: s.deskMode === "dm" ? "✅ 私聊卡片" : "💬 私聊卡片", callback_data: "mc:deskMode:dm" }],
            [{ text: s.deskMode === "dm_topics" ? "✅ 私聊话题（实验）" : "🧪 私聊话题（实验）", callback_data: "mc:deskMode:dm_topics" }],
            ...(s.botUsername ? [[{ text: s.deskMode === "group" ? "✅ 话题群（换一个群）" : "👥 绑定话题群", url: `https://t.me/${s.botUsername}?startgroup=bind&admin=manage_topics` }]] : []),
            BACK,
          ],
        },
      };
    case "welcome":
      return {
        text: `<b>👋 第一次的自动回复</b>\n陌生人第一次私信机器人时发一次，之后不再发。\n\n<b>文字：</b>\n${clipHtml(s.welcome, 2500) || "（没有）"}\n\n<b>图片：</b>${s.welcomeImage ? "已设置" : "没有"}`,
        keyboard: {
          inline_keyboard: [
            [{ text: "✏️ 改文字", callback_data: "mi:welcome" }, { text: s.welcomeImage ? "🖼 换图片" : "🖼 加图片", callback_data: "mi:welcomePhoto" }],
            ...(s.welcomeImage ? [[{ text: "🗑 去掉图片", callback_data: "mc:welcomePhoto:off" }]] : []),
            BACK,
          ],
        },
      };
    case "clean":
      return {
        text: `<b>🧹 自动清理</b>\n面板、提示、点过的命令到时间自动删掉，聊天窗口保持干净。别人的私信和你的回复不会动。\n\n现在：${s.uiCleanHours ? `${s.uiCleanHours} 小时后清理` : "不清理"}`,
        keyboard: {
          inline_keyboard: [
            [1, 6, 24, 0].map((hours) => ({ text: `${s.uiCleanHours === hours ? "✅ " : ""}${hours ? `${hours} 小时` : "不清理"}`, callback_data: `mc:uiClean:${hours}` })),
            BACK,
          ],
        },
      };
    case "verify":
      return {
        text:
          "<b>🔐 人机验证</b>\n陌生人第一次发消息要答一道题，验证前发的消息会暂存，通过后自动转给你。\n\n" +
          `状态：${s.verifyMode === "quiz" ? "开" : "关"}\n` +
          `有效期：${s.verifyTtlDays === 0 ? "通过一次永久有效" : `${s.verifyTtlDays} 天`}`,
        keyboard: {
          inline_keyboard: [
            [{ text: s.verifyMode === "quiz" ? "⬜️ 关闭验证" : "✅ 打开验证", callback_data: "mc:verifyMode:" + (s.verifyMode === "quiz" ? "off" : "quiz") }],
            [{ text: "⏳ 改有效期", callback_data: "mi:verifyTtlDays" }],
            BACK,
          ],
        },
      };
    case "auto":
      return {
        text:
          "<b>💬 自动回复</b>\n\n" +
                    `<b>收到回执</b>（${onOff(s.receiptEnabled)}）：每条消息上打 👌，隔了 30 天再来才发这句话：\n${clipHtml(s.receipt, 900)}\n\n` +
          `<b>离线回复</b>（${onOff(s.offlineEnabled)}，在线时段 ${s.onlineFrom}:00–${s.onlineTo}:00，${escapeHtml(s.timezone)}）：\n${clipHtml(s.offlineMessage, 900)}`,
        keyboard: {
          inline_keyboard: [
            [{ text: "👋 第一次的自动回复", callback_data: "m:welcome" }],
            [{ text: toggle(s.receiptEnabled, "收到回执"), callback_data: "mt:receiptEnabled" }, { text: "✏️ 改回执文字", callback_data: "mi:receipt" }],
            [{ text: toggle(s.offlineEnabled, "离线回复"), callback_data: "mt:offlineEnabled" }, { text: "✏️ 改离线文字", callback_data: "mi:offlineMessage" }],
            [{ text: "🕘 改在线时段", callback_data: "mi:onlineHours" }, { text: "🌏 改时区", callback_data: "mi:timezone" }],
            [{ text: "🤖 关键词回复", callback_data: "rl:0" }],
            BACK,
          ],
        },
      };
    case "filter":
      return {
        text:
          "<b>🛡 防骚扰</b>\n命中规则的消息进隔离区，不会丢，可以查看和放行。\n\n" +
          `屏蔽关键词：${s.blockedKeywords.length ? clipHtml(s.blockedKeywords.join("、"), 2500) : "无"}\n` +
          `新联系人发链接进隔离：${onOff(s.blockLinksForNew)}\n` +
          `转发内容进隔离：${onOff(s.blockForwards)}\n` +
          `新联系人先审核再转发：${onOff(s.reviewNewContacts)}\n` +
          `每人每分钟上限：${s.messagesPerMinute} 条\n` +
          `防轰炸阈值：10 分钟新增 ${s.floodThreshold} 人`,
        keyboard: {
          inline_keyboard: [
            [{ text: "🚫 改屏蔽关键词", callback_data: "mi:blockedKeywords" }],
            [{ text: toggle(s.blockLinksForNew, "新人发链接拦截"), callback_data: "mt:blockLinksForNew" }, { text: toggle(s.blockForwards, "转发内容拦截"), callback_data: "mt:blockForwards" }],
            [{ text: toggle(s.reviewNewContacts, "新人先审核"), callback_data: "mt:reviewNewContacts" }],
            [{ text: "⏱ 改每分钟上限", callback_data: "mi:messagesPerMinute" }, { text: "🌊 改防轰炸阈值", callback_data: "mi:floodThreshold" }],
            [{ text: "🛡 打开隔离区", callback_data: "filtered:0" }],
            BACK,
          ],
        },
      };
    case "data":
      return {
        text:
          "<b>🗄 数据</b>\n\n" +
          `聊天内容保留：${s.retentionDays === 0 ? "永久" : `${s.retentionDays} 天`}\n` +
          "到期后抹掉文字和文件编号，联系人和回复关系还在，老消息依然能回复。",
        keyboard: {
          inline_keyboard: [
            [{ text: "🗓 改保留天数", callback_data: "mi:retentionDays" }],
            [{ text: "🧹 手动清理", callback_data: "cl" }, { text: "📦 导出数据", callback_data: "ex" }],
            BACK,
          ],
        },
      };
    default:
      return {
        text: `<b>⚙️ 设置</b>\n\n消息收在：${deskModeLabel(s)}\n人机验证：${s.verifyMode === "quiz" ? "开" : "关"}\n聊天保留：${s.retentionDays === 0 ? "永久" : `${s.retentionDays} 天`}`,
        keyboard: {
          inline_keyboard: [
            [{ text: "👋 第一次的自动回复", callback_data: "m:welcome" }, { text: "💬 自动回复", callback_data: "m:auto" }],
            [{ text: "🔐 人机验证", callback_data: "m:verify" }, { text: "🛡 防骚扰", callback_data: "m:filter" }],
            [{ text: `🧹 自动清理：${s.uiCleanHours ? `${s.uiCleanHours} 小时` : "关"}`, callback_data: "m:clean" }],
            [{ text: "📥 消息收在哪", callback_data: "m:desk" }, { text: "🗄 数据", callback_data: "m:data" }],
            backRow(),
          ],
        },
      };
  }
}

/** 能开关的配置项 → 所在菜单页 */
export const TOGGLES: Record<string, { key: "receiptEnabled" | "offlineEnabled" | "blockLinksForNew" | "blockForwards" | "reviewNewContacts"; page: string }> = {
  receiptEnabled: { key: "receiptEnabled", page: "auto" },
  offlineEnabled: { key: "offlineEnabled", page: "auto" },
  blockLinksForNew: { key: "blockLinksForNew", page: "filter" },
  blockForwards: { key: "blockForwards", page: "filter" },
  reviewNewContacts: { key: "reviewNewContacts", page: "filter" },
};

interface InputSpec {
  prompt: string;
  /** 校验并保存，返回错误提示；返回 null 表示成功 */
  apply(app: App, text: string): Promise<string | null>;
}

function intInput(prompt: string, key: "verifyTtlDays" | "messagesPerMinute" | "floodThreshold" | "retentionDays", min: number, max: number): InputSpec {
  return {
    prompt,
    async apply(app, text) {
      const value = Number(text.trim());
      if (!Number.isInteger(value) || value < min || value > max) return `请发 ${min} 到 ${max} 之间的整数。`;
      await saveSetting(app.db, app.settings, key, value);
      return null;
    },
  };
}

function textInput(prompt: string, key: "welcome" | "receipt" | "offlineMessage"): InputSpec {
  return {
    prompt,
    async apply(app, text) {
      if (text.length > 2000) return "太长了，请控制在 2000 字以内。";
      await saveSetting(app.db, app.settings, key, text);
      return null;
    },
  };
}

export const INPUTS: Record<string, InputSpec> = {
  welcome: textInput("发来新的文字。", "welcome"),
  welcomePhoto: {
    prompt: "发来一张图片。",
    async apply() {
      return "这里要发图片。";
    },
  },
  receipt: textInput("发来新的收到回执。", "receipt"),
  offlineMessage: textInput("发来新的离线回复。", "offlineMessage"),
  verifyTtlDays: intInput("验证多少天有效？发 0 表示通过一次永久有效。", "verifyTtlDays", 0, 3650),
  messagesPerMinute: intInput("每人每分钟最多多少条？", "messagesPerMinute", 1, 600),
  floodThreshold: intInput("10 分钟内新增多少个陌生人算被轰炸？", "floodThreshold", 3, 100000),
  retentionDays: intInput("聊天内容保留多少天？发 0 表示永久。", "retentionDays", 0, 36500),
  blockedKeywords: {
    prompt: "发来屏蔽关键词，用逗号或换行分隔。发 0 清空。",
    async apply(app, text) {
      const words = text.trim() === "0" ? [] : text.split(/[,，、\n]/).map((word) => word.trim()).filter(Boolean);
      if (words.length > 500) return "最多 500 个关键词。";
      await saveSetting(app.db, app.settings, "blockedKeywords", words);
      return null;
    },
  },
  onlineHours: {
    prompt: "发来在线时段，24 小时制，比如 9-22。跨夜写 22-6。",
    async apply(app, text) {
      const match = /^\s*(\d{1,2})\s*[-–~到]\s*(\d{1,2})\s*$/.exec(text);
      const from = Number(match?.[1]);
      const to = Number(match?.[2]);
      if (!match || from > 23 || to > 24 || from === to) return "格式不对，比如 9-22。";
      await saveSetting(app.db, app.settings, "onlineFrom", from);
      await saveSetting(app.db, app.settings, "onlineTo", to);
      return null;
    },
  },
  timezone: {
    prompt: "发来时区，比如 Asia/Shanghai、Asia/Tokyo、Europe/London。",
    async apply(app, text) {
      const zone = text.trim();
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
      } catch {
        return "没有这个时区，写法比如 Asia/Shanghai。";
      }
      await saveSetting(app.db, app.settings, "timezone", zone);
      return null;
    },
  },
};

const AWAITING_TTL = 10 * 60;

export interface AwaitScope {
  chatId: number;
  threadId: number | undefined;
}

/**
 * 记下在等管理员输入什么，以及在哪个聊天和话题等。换了地方发的话是给客户的，不能当成输入。
 * 群里同时记在群 ID 下：匿名管理员点按钮时是真人 ID，发消息时身份却是群。
 */
export async function setAwaiting(app: App, staffId: number, what: string, scope: AwaitScope): Promise<void> {
  const value = `${scope.chatId}:${scope.threadId ?? ""}|${what}`;
  for (const id of scope.chatId < 0 ? [staffId, scope.chatId] : [staffId]) {
    await app.db
      .prepare("INSERT INTO staff_state(staff_id, awaiting, awaiting_at) VALUES(?, ?, ?) ON CONFLICT(staff_id) DO UPDATE SET awaiting = excluded.awaiting, awaiting_at = excluded.awaiting_at")
      .bind(id, value, app.now())
      .run();
  }
}

export async function clearAwaiting(app: App, staffId: number, chatId: number): Promise<void> {
  await app.db.prepare("UPDATE staff_state SET awaiting = NULL, awaiting_at = NULL WHERE staff_id IN (?, ?)").bind(staffId, chatId).run();
}

/** 还在等这个人在这个位置输入的内容；没有、已过期或换了地方都返回 null。 */
export async function currentAwaiting(app: App, staffId: number, message: Message): Promise<string | null> {
  const row = await app.db.prepare("SELECT awaiting, awaiting_at FROM staff_state WHERE staff_id = ?").bind(staffId).first<{ awaiting: unknown; awaiting_at: unknown }>();
  const value = str(row?.awaiting);
  if (!value || typeof row?.awaiting_at !== "number" || app.now() - row.awaiting_at > AWAITING_TTL) return null;
  const split = value.indexOf("|");
  if (value.slice(0, split) !== `${message.chat.id}:${message.message_thread_id ?? ""}`) return null;
  return value.slice(split + 1);
}

/** 管理员刚点过「改 xx」，下一条消息当作输入。返回 true 表示已处理。 */
export async function handleAwaitingInput(app: App, message: Message, staffId: number): Promise<boolean> {
  const awaiting = await currentAwaiting(app, staffId, message);
  if (!awaiting) return false;
  const text = message.text ?? "";
  const reply = (body: string, keyboard?: unknown) =>
    app.tg.call("sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
      text: body,
      ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
    });
  if (text === "/cancel") {
    await clearAwaiting(app, staffId, message.chat.id);
    await reply("已取消。");
    return true;
  }
  // 打了别的命令就是不想继续这一步了，否则之后发的话会被当成输入
  if (text.startsWith("/")) {
    await clearAwaiting(app, staffId, message.chat.id);
    return false;
  }
  // 第一次自动回复可以带图片：发图就换图，图片说明就是文字
  if ((awaiting === "welcome" || awaiting === "welcomePhoto") && message.photo?.length) {
    await saveSetting(app.db, app.settings, "welcomePhotoId", message.photo.at(-1)?.file_id ?? "");
    await saveSetting(app.db, app.settings, "welcomeImage", true);
    await app.db.prepare("DELETE FROM assets WHERE name = 'welcome'").run();
    if (message.caption) await saveSetting(app.db, app.settings, "welcome", message.caption.slice(0, 2000));
    await clearAwaiting(app, staffId, message.chat.id);
    await reply("已保存。", { inline_keyboard: [[{ text: "⬅️ 返回", callback_data: "m:welcome" }]] });
    return true;
  }
  if (!text) {
    await reply("这里要发文字。", CANCEL_KEYBOARD);
    return true;
  }
  if (awaiting.startsWith("note:")) {
    const userId = Number(awaiting.slice(5));
    if (!Number.isSafeInteger(userId)) {
      await clearAwaiting(app, staffId, message.chat.id);
      return false;
    }
    await app.db.prepare("UPDATE contacts SET note = ? WHERE user_id = ?").bind(text.trim() === "0" ? "" : text.slice(0, 500), userId).run();
    await clearAwaiting(app, staffId, message.chat.id);
    await reply("备注已保存。");
    return true;
  }
  const spec = INPUTS[awaiting];
  if (!spec) {
    await clearAwaiting(app, staffId, message.chat.id);
    return false;
  }
  const failure = await spec.apply(app, text);
  if (failure) {
    await reply(failure, CANCEL_KEYBOARD);
    return true;
  }
  await clearAwaiting(app, staffId, message.chat.id);
  await reply("已保存。", { inline_keyboard: [[{ text: "⬅️ 返回", callback_data: awaiting === "welcome" ? "m:welcome" : "m:main" }]] });
  return true;
}
