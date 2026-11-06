import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALICE, BOB, GROUP, makeHarness, OWNER } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { num } from "../src/core/db.ts";
import { handleUpdate } from "../src/core/router.ts";
import { broadcastTick, retryFailed, tick } from "../src/core/maintenance.ts";
import { CLAIM_PAIRS, createClaim } from "../src/core/setup.ts";
import { loadSettings } from "../src/core/settings.ts";
import { cryptoRng, makeChallenge } from "../src/core/verify.ts";

let h: Harness;

afterEach(() => {
  expect(h.tg.rejected).toEqual([]);
});

async function row(sql: string, ...values: (string | number)[]) {
  const result = await h.app.db.prepare(sql).bind(...values).first();
  if (!result) throw new Error(`查询无结果：${sql}`);
  return result;
}

describe("私聊卡片模式", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("联系人的消息带卡片复制给管理员，不是重发文字", async () => {
    await h.fromUser(ALICE, "你好");
    expect(h.tg.textsTo(OWNER)[0]).toContain("用户2001");
    const copy = h.tg.last("copyMessage");
    expect(copy).toMatchObject({ chat_id: OWNER, from_chat_id: ALICE });
    expect(copy.reply_parameters).toBeDefined();
  });

  it("同一个人连发不重复发卡片，换人才发", async () => {
    await h.fromUser(ALICE, "1");
    await h.fromUser(ALICE, "2");
    const cards = () => h.tg.textsTo(OWNER).filter((text) => text.includes("首次联系")).length;
    expect(cards()).toBe(1);
    await h.fromUser(BOB, "3");
    expect(cards()).toBe(2);
    await h.fromUser(ALICE, "4");
    expect(cards()).toBe(3);
  });

  it("回复转来的消息会精确发给对应的人，不串", async () => {
    await h.fromUser(ALICE, "我是 A");
    const aliceCopy = num(await row("SELECT desk_msg_id FROM messages WHERE user_id = ?", ALICE).then((r) => r.desk_msg_id));
    await h.fromUser(BOB, "我是 B");
    h.tg.reset();
    await h.fromOwner("回给 A", { reply_to_message: { message_id: aliceCopy, chat: { id: OWNER, type: "private" }, date: 0 } });
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: ALICE, from_chat_id: OWNER });
    expect(h.tg.last("setMessageReaction").reaction).toEqual([{ type: "emoji", emoji: "👌" }]);
  });

  it("点卡片上的回复路由也能认", async () => {
    await h.fromUser(ALICE, "hi");
    const card = num((await row("SELECT message_id FROM cards WHERE user_id = ?", ALICE)).message_id);
    h.tg.reset();
    await h.fromOwner("收到", { reply_to_message: { message_id: card, chat: { id: OWNER, type: "private" }, date: 0 } });
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: ALICE });
  });

  it("没选中也没引用时提示没发出去，不会默默丢", async () => {
    await h.fromOwner("随便说点");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("没发出去");
  });

  it("选中后直接发给选中的人", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    h.tg.reset();
    await h.fromOwner("直接发");
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: ALICE });
  });

  it("对方拉黑机器人时明确告诉管理员并记下", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    h.tg.failNext("copyMessage", 403, "Forbidden: bot was blocked by the user");
    await h.fromOwner("还在吗");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("已拉黑机器人");
    expect((await row("SELECT unreachable_at FROM contacts WHERE user_id = ?", ALICE)).unreachable_at).not.toBeNull();
  });

  it("以 // 开头的内部备注不发给对方", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    h.tg.reset();
    await h.fromOwner("// 这人是老客户");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    expect(h.tg.last("setMessageReaction").reaction).toEqual([{ type: "emoji", emoji: "✍" }]);
  });

  it("命令不会被当成回复发给对方", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    h.tg.reset();
    await h.fromOwner("/help");
    await h.fromOwner("/nosuch");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
  });

  it("以 / 开头但不是命令的内容不转发，并且说清楚，不能默默吞掉", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    h.tg.reset();
    for (const text of ["/etc/hosts", "/你好"]) {
      await h.fromOwner(text);
      expect(h.tg.named("copyMessage")).toHaveLength(0);
      expect(h.tg.textsTo(OWNER).at(-1)).toContain("没发出去");
    }
  });

  it("选中 B 时回复一条认不出的消息，不能发给 B", async () => {
    await h.fromUser(BOB, "我是 B");
    await h.press(OWNER, OWNER, 1, `select:${BOB}`);
    h.tg.reset();
    await h.fromOwner("这条是回给 A 的", { reply_to_message: { message_id: 424242, chat: { id: OWNER, type: "private" }, date: 0 } });
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("认不出");
  });

  it("选中 B 时回复 A 的搜索卡片，发给 A", async () => {
    await h.fromUser(ALICE, "我是 A");
    await h.fromUser(BOB, "我是 B");
    await h.press(OWNER, OWNER, 1, `select:${BOB}`);
    h.tg.reset();
    await h.fromOwner(`/search ${ALICE}`);
    const card = h.tg.nextId - 1;
    h.tg.reset();
    await h.fromOwner("回给 A", { reply_to_message: { message_id: card, chat: { id: OWNER, type: "private" }, date: 0 } });
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: ALICE });
  });

  it("相同 update_id 重复投递只处理一次", async () => {
    const update = { update_id: 9999, message: { message_id: 1, date: 0, chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false, first_name: "a" }, text: "x" } };
    await h.send(update as never);
    await h.send(update as never);
    expect(h.tg.named("copyMessage")).toHaveLength(1);
  });

  it("转发失败时不丢消息：记 failed，定时任务补发", async () => {
    await h.fromUser(ALICE, "第一次"); // 先发一条让卡片存在
    h.tg.failNext("copyMessage", 429, "Too Many Requests", 60);
    await h.fromUser(ALICE, "被限流的");
    expect((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed'")).n).toBe(1);
    expect(h.tg.textsTo(ALICE).at(-1)).toContain("不用重发");
    h.tg.reset();
    const { retryFailed } = await import("../src/core/maintenance.ts");
    await retryFailed(h.app);
    expect(h.tg.named("copyMessage")).toHaveLength(1);
    expect((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed'")).n).toBe(0);
  });

  it("copyMessage 不支持的类型退回转发", async () => {
    h.tg.failNext("copyMessage", 400, "Bad Request: message can't be copied");
    await h.fromUser(ALICE, "特殊消息");
    expect(h.tg.named("forwardMessage")).toHaveLength(1);
  });

  it("相册缓冲后用 copyMessages 一起发，保持相册", async () => {
    const photo = { photo: [{ file_id: "f1", file_unique_id: "u", width: 1, height: 1 }], media_group_id: "g1" };
    await h.fromUser(ALICE, "", photo);
    await h.fromUser(ALICE, "", photo);
    expect(h.tg.named("copyMessages")).toHaveLength(0);
    h.clock.now += 2;
    await h.deferred.run();
    const calls = h.tg.named("copyMessages");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message_ids).toHaveLength(2);
    expect((await row("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND status = 'sent'", ALICE)).n).toBe(2);
    expect((await row("SELECT COUNT(*) AS n FROM album_buffer")).n).toBe(0);
  });
});

describe("验证", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("验证前发的消息先留着，通过后补发，用户不用重发", async () => {
    await h.fromUser(ALICE, "急事！");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    expect(h.tg.textsTo(ALICE).at(-1)).toContain("答一道题");
    await h.passVerification(ALICE);
    expect(h.tg.named("copyMessage")).toHaveLength(1);
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: OWNER, from_chat_id: ALICE });
  });

  it("验证题答案不出现在回调数据里", async () => {
    await h.fromUser(ALICE, "hi");
    const markup = h.tg.last("sendMessage").reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    for (const button of markup.inline_keyboard.flat()) {
      expect(button.callback_data).not.toContain(`:${button.text}`);
    }
  });

  it("点旧题不算失败", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(ALICE, ALICE, 1, "v:oldchallenge:whatever");
    expect((await row("SELECT failed_attempts FROM contacts WHERE user_id = ?", ALICE)).failed_attempts).toBe(0);
  });

  it("超时不算失败，自动换题", async () => {
    await h.fromUser(ALICE, "hi");
    const first = await row("SELECT challenge_id FROM contacts WHERE user_id = ?", ALICE);
    h.clock.now += 301;
    await h.press(ALICE, ALICE, 1, `v:${String(first.challenge_id)}:wrong`);
    const after = await row("SELECT challenge_id, failed_attempts FROM contacts WHERE user_id = ?", ALICE);
    expect(after.failed_attempts).toBe(0);
    expect(after.challenge_id).not.toBe(first.challenge_id);
  });

  it("连错 3 次锁定，锁定期内消息不处理，到期恢复", async () => {
    await h.fromUser(ALICE, "hi");
    for (let i = 0; i < 3; i++) {
      const current = await row("SELECT challenge_id FROM contacts WHERE user_id = ?", ALICE);
      await h.press(ALICE, ALICE, 1, `v:${String(current.challenge_id)}:wrong`);
    }
    const locked = await row("SELECT locked_until FROM contacts WHERE user_id = ?", ALICE);
    expect(num(locked.locked_until)).toBeGreaterThan(h.clock.now);
    h.tg.reset();
    await h.fromUser(ALICE, "放我进去");
    expect(h.tg.calls).toHaveLength(0);
    h.clock.now += 3601;
    await h.fromUser(ALICE, "好了吗");
    expect(h.tg.textsTo(ALICE).at(-1)).toContain("答一道题");
  });

  it("待答题期间连发不会刷出一堆题", async () => {
    await h.fromUser(ALICE, "1");
    await h.fromUser(ALICE, "2");
    await h.fromUser(ALICE, "3");
    expect(h.tg.textsTo(ALICE).filter((text) => text.includes("答一道题"))).toHaveLength(1);
  });

  it("暂存消息有上限，防止灌库", async () => {
    await h.set("messagesPerMinute", 1000);
    for (let i = 0; i < 40; i++) await h.fromUser(ALICE, `m${i}`);
    expect((await row("SELECT COUNT(*) AS n FROM held_messages")).n).toBe(30);
  });

  it("验证前发的违禁内容，通过验证后进隔离区，不会被补发", async () => {
    await h.set("blockedKeywords", ["博彩"]);
    await h.fromUser(ALICE, "顶级博彩");
    await h.fromUser(ALICE, "看这个 https://spam.example", { entities: [{ type: "url", offset: 4, length: 20 }] });
    await h.fromUser(ALICE, "正常的话");
    await h.passVerification(ALICE);
    expect(h.tg.named("copyMessage")).toHaveLength(1);
    expect((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'filtered'")).n).toBe(2);
    expect((await row("SELECT COUNT(*) AS n FROM held_messages")).n).toBe(0);
  });

  it("审核模式下，验证前的消息也要审核，并通知主人一次", async () => {
    await h.set("reviewNewContacts", true);
    await h.fromUser(ALICE, "第一条");
    await h.fromUser(ALICE, "第二条");
    await h.passVerification(ALICE);
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    expect(h.tg.textsTo(OWNER).filter((text) => text.includes("待审核"))).toHaveLength(1);
    await h.press(OWNER, OWNER, 1, `approve:${ALICE}`);
    expect(h.tg.named("copyMessage")).toHaveLength(2);
  });

  it("免验证的联系人直接转发", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `exempt:${ALICE}`);
    h.tg.reset();
    await h.fromUser(ALICE, "again");
    // 新消息一条，加上验证前暂存的那条
    expect(h.tg.named("copyMessage")).toHaveLength(2);
  });
});

describe("话题群模式", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
    await h.set("deskMode", "group");
    await h.set("groupId", GROUP);
  });

  async function threadOf(userId: number): Promise<number> {
    return num((await row("SELECT thread_id FROM contacts WHERE user_id = ?", userId)).thread_id);
  }

  it("每个联系人一个话题，第二条不再建", async () => {
    await h.fromUser(ALICE, "1");
    await h.fromUser(ALICE, "2");
    await h.fromUser(BOB, "3");
    expect(h.tg.named("createForumTopic")).toHaveLength(2);
    expect(h.tg.last("copyMessage").message_thread_id).toBe(await threadOf(BOB));
  });

  it("话题里发的消息发给对应联系人，任何群成员都能回", async () => {
    await h.fromUser(ALICE, "hi");
    const thread = await threadOf(ALICE);
    h.tg.reset();
    await h.fromGroup(7777, "你好", thread);
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: ALICE, from_chat_id: GROUP });
    expect((await row("SELECT staff_id FROM messages WHERE direction = 'out'")).staff_id).toBe(7777);
  });

  it("匿名管理员也能回复", async () => {
    await h.fromUser(ALICE, "hi");
    const thread = await threadOf(ALICE);
    h.tg.reset();
    await h.fromGroup(1087968824, "匿名回复", thread, { from: { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" }, sender_chat: { id: GROUP, type: "supergroup", title: "客服" } });
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: ALICE });
  });

  it("其他机器人的消息不会转给联系人", async () => {
    await h.fromUser(ALICE, "hi");
    const thread = await threadOf(ALICE);
    h.tg.reset();
    await h.fromGroup(555, "我是别的 bot", thread, { from: { id: 555, is_bot: true, first_name: "b" } });
    expect(h.tg.named("copyMessage")).toHaveLength(0);
  });

  it("话题被删后自动重建，消息照样送到", async () => {
    await h.fromUser(ALICE, "hi");
    const old = await threadOf(ALICE);
    h.tg.reset();
    h.tg.failNext("copyMessage", 400, "Bad Request: message thread not found");
    await h.fromUser(ALICE, "还在吗");
    expect(h.tg.named("createForumTopic")).toHaveLength(1);
    const fresh = await threadOf(ALICE);
    expect(fresh).not.toBe(old);
    expect(h.tg.last("copyMessage").message_thread_id).toBe(fresh);
    expect((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed'")).n).toBe(0);
  });

  it("话题被关闭时自动重开", async () => {
    await h.fromUser(ALICE, "hi");
    h.tg.reset();
    h.tg.failNext("copyMessage", 400, "Bad Request: TOPIC_CLOSED");
    await h.fromUser(ALICE, "再问一下");
    expect(h.tg.named("reopenForumTopic")).toHaveLength(1);
    expect(h.tg.named("copyMessage")).toHaveLength(2);
  });

  it("不是绑定的群，消息完全不碰", async () => {
    await h.send({ message: { message_id: 1, date: 0, chat: { id: -999, type: "supergroup", title: "别的群", is_forum: true }, from: { id: ALICE, is_bot: false, first_name: "a" }, text: "大家好" } as never });
    expect(h.tg.calls).toHaveLength(0);
    expect((await h.app.db.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>())?.n).toBe(0);
  });

  it("话题创建这种服务消息不转发", async () => {
    await h.fromUser(ALICE, "hi");
    const thread = await threadOf(ALICE);
    h.tg.reset();
    await h.fromGroup(7777, "", thread, { text: undefined, forum_topic_created: { name: "x", icon_color: 1 } });
    expect(h.tg.calls).toHaveLength(0);
  });

  it("主人在私聊里发普通消息会提示去群里", async () => {
    await h.fromOwner("hello");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("话题群模式");
  });

  it("绑定命令逐项检查：匿名、没开话题、没权限", async () => {
    await h.set("deskMode", "dm");
    await h.set("groupId", null);
    const bind = (extra: object) => h.send({ message: { message_id: 9, date: 0, chat: { id: GROUP, type: "supergroup", title: "t" }, text: "/bindgroup", ...extra } as never });

    await bind({ from: { id: 1087968824, is_bot: true, first_name: "G" }, sender_chat: { id: GROUP, type: "supergroup", title: "t" } });
    expect(String(h.tg.last("sendMessage").text)).toContain("匿名");

    h.tg.responses.set("getChat", { is_forum: false });
    await bind({ from: { id: OWNER, is_bot: false, first_name: "o" } });
    expect(String(h.tg.last("sendMessage").text)).toContain("没开话题");

    h.tg.responses.set("getChat", { is_forum: true });
    h.tg.responses.set("getChatMember", { status: "member" });
    await bind({ from: { id: OWNER, is_bot: false, first_name: "o" } });
    expect(String(h.tg.last("sendMessage").text)).toContain("还不是这个群的管理员");

    h.tg.responses.set("getChatMember", { status: "administrator", can_manage_topics: true });
    await bind({ from: { id: OWNER, is_bot: false, first_name: "o" } });
    expect(String(h.tg.last("sendMessage").text)).toContain("绑定成功");
    expect(h.app.settings.groupId).toBe(GROUP);
  });

  it("陌生人不能绑定群", async () => {
    await h.set("deskMode", "dm");
    await h.set("groupId", null);
    await h.send({ message: { message_id: 9, date: 0, chat: { id: GROUP, type: "supergroup", title: "t" }, from: { id: ALICE, is_bot: false, first_name: "a" }, text: "/bindgroup" } as never });
    expect(String(h.tg.last("sendMessage").text)).toContain("只有机器人的主人");
    expect(h.app.settings.groupId).toBeNull();
  });

  it("机器人被踢出话题群后切回私聊，消息不丢", async () => {
    await h.send({ my_chat_member: { chat: { id: GROUP, type: "supergroup", title: "t" }, from: { id: 1, is_bot: false, first_name: "x" }, date: 0, old_chat_member: { status: "administrator" }, new_chat_member: { status: "left", user: { id: 42 } } } as never });
    h.tg.reset();
    await h.fromUser(ALICE, "hi");
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: OWNER });
  });
});

describe("拦截和防骚扰", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("命中关键词进隔离区，不转发，放行后才转", async () => {
    await h.set("blockedKeywords", ["博彩"]);
    await h.fromUser(ALICE, "顶级博彩平台");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    const stored = await row("SELECT id, reason FROM messages WHERE status = 'filtered'");
    expect(String(stored.reason)).toContain("博彩");
    await h.press(OWNER, OWNER, 1, `release:${num(stored.id)}`);
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: OWNER, from_chat_id: ALICE });
    expect((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'filtered'")).n).toBe(0);
  });

  it("新联系人发链接进隔离，聊过几条的老联系人不受影响", async () => {
    await h.fromUser(ALICE, "看这个 https://spam.example");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    await h.app.db.prepare("UPDATE contacts SET msg_count = 10 WHERE user_id = ?").bind(ALICE).run();
    await h.fromUser(ALICE, "看这个 https://ok.example");
    expect(h.tg.named("copyMessage")).toHaveLength(1);
  });

  it("新联系人审核模式：通知主人，放行后补发", async () => {
    await h.set("reviewNewContacts", true);
    await h.fromUser(ALICE, "第一条");
    await h.fromUser(ALICE, "第二条");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    expect(h.tg.textsTo(OWNER).filter((text) => text.includes("待审核"))).toHaveLength(1);
    await h.press(OWNER, OWNER, 1, `approve:${ALICE}`);
    expect(h.tg.named("copyMessage")).toHaveLength(2);
    h.tg.reset();
    await h.fromUser(ALICE, "第三条");
    expect(h.tg.named("copyMessage")).toHaveLength(1);
  });

  it("被屏蔽的人静默丢弃，不耗 API", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `block:${ALICE}`);
    h.tg.reset();
    await h.fromUser(ALICE, "还想说话");
    expect(h.tg.calls).toHaveLength(0);
  });

  it("超过每分钟上限暂停 10 分钟，只提醒一次，到期恢复", async () => {
    await h.set("messagesPerMinute", 2);
    await h.fromUser(ALICE, "1");
    await h.fromUser(ALICE, "2");
    await h.fromUser(ALICE, "3");
    await h.fromUser(ALICE, "4");
    expect(h.tg.textsTo(ALICE).filter((text) => text.includes("太快了"))).toHaveLength(1);
    expect(h.tg.named("copyMessage")).toHaveLength(2);
    h.clock.now += 601;
    await h.fromUser(ALICE, "5");
    expect(h.tg.named("copyMessage")).toHaveLength(3);
  });

  it("新联系人突增触发防轰炸，老联系人不受影响，可一键解除", async () => {
    await h.fromUser(ALICE, "老客户");
    await h.app.db.prepare("UPDATE contacts SET verified_at = 1 WHERE user_id = ?").bind(ALICE).run();
    await h.set("floodThreshold", 3);
    await h.set("verifyMode", "quiz");
    h.clock.now += 700;
    await h.fromUser(3001, "x");
    await h.fromUser(3002, "x");
    await h.fromUser(3003, "x");
    expect(h.tg.textsTo(OWNER).some((text) => text.includes("疑似被轰炸"))).toBe(true);
    h.tg.reset();
    await h.fromUser(3004, "x");
    expect(h.tg.calls).toHaveLength(0);
    await h.fromUser(ALICE, "还能说话");
    expect(h.tg.named("copyMessage")).toHaveLength(1);
    await h.press(OWNER, OWNER, 1, "flood_off");
    h.tg.reset();
    await h.fromUser(3005, "x");
    expect(h.tg.textsTo(3005).at(-1)).toContain("答一道题");
  });

  it("同一秒内连发不会把一个人算成多个新联系人", async () => {
    await h.fromUser(ALICE, "1");
    await h.fromUser(ALICE, "2");
    await h.fromUser(ALICE, "3");
    const stats = await row("SELECT new_contacts FROM daily_stats");
    expect(stats.new_contacts).toBe(1);
  });
});

describe("自动回复", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("/start 发欢迎语，不转给管理员", async () => {
    await h.fromUser(ALICE, "/start");
    expect(h.tg.textsTo(ALICE)[0]).toBe(h.app.settings.welcome);
    expect(h.tg.named("copyMessage")).toHaveLength(0);
  });

  it("收到回执：每条消息打 👌，文字只发第一次，30 天后才再发", async () => {
    const receipts = () => h.tg.textsTo(ALICE).filter((text) => text === h.app.settings.receipt).length;
    await h.fromUser(ALICE, "1");
    await h.fromUser(ALICE, "2");
    // 第一次回的是自动回复，不再多回一句「已收到」
    expect(h.tg.textsTo(ALICE)).toEqual([h.app.settings.welcome]);
    expect(receipts()).toBe(0);
    expect(h.tg.named("setMessageReaction").filter((params) => params.chat_id === ALICE)).toHaveLength(2);
    await h.app.db.prepare("UPDATE contacts SET unread = 0 WHERE user_id = ?").bind(ALICE).run();
    h.clock.now += 29 * 86_400;
    await h.fromUser(ALICE, "3");
    expect(receipts()).toBe(0);
    await h.app.db.prepare("UPDATE contacts SET unread = 0 WHERE user_id = ?").bind(ALICE).run();
    h.clock.now += 86_400 + 1;
    await h.fromUser(ALICE, "4");
    expect(receipts()).toBe(1);
  });

  it("关了回执，不打 👌 也不发「已收到」，第一次的自动回复还在", async () => {
    await h.set("receiptEnabled", false);
    await h.fromUser(ALICE, "1");
    expect(h.tg.textsTo(ALICE)).toEqual([h.app.settings.welcome]);
    expect(h.tg.named("setMessageReaction")).toHaveLength(0);
  });

  it("打 👌 失败不影响消息送达", async () => {
    h.tg.failNext("setMessageReaction", 400, "Bad Request: REACTION_INVALID");
    await h.fromUser(ALICE, "1");
    expect(h.tg.named("copyMessage").length).toBe(1);
    expect(h.tg.textsTo(ALICE)).toContain(h.app.settings.welcome);
  });

  it("回复别人：有未读的排最前，点名字选中后有明确提示，首页显示正在回复谁", async () => {
    await h.fromUser(ALICE, "早来的");
    await h.fromUser(BOB, "晚来的");
    await h.app.db.prepare("UPDATE contacts SET unread = 0 WHERE user_id = ?").bind(BOB).run();
    await h.press(OWNER, OWNER, 1, "list:0");
    const first = (h.tg.last("editMessageText").reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard[0]?.[0]?.text;
    expect(first).toContain("用户2001");
    await h.press(OWNER, OWNER, 2, `select:${BOB}`);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("现在发的消息都给");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("用户2002");
    await h.press(OWNER, OWNER, 3, "p:main");
    const panel = h.tg.last("editMessageText").reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    expect(panel.inline_keyboard[0]?.[0]?.text).toContain("正在回复：用户2002");
    h.tg.reset();
    await h.fromOwner("给你的回复");
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === BOB)).toBe(true);
    await h.press(OWNER, OWNER, 3, `unselect:${BOB}`);
    await h.press(OWNER, OWNER, 3, "p:main");
    const after = h.tg.last("editMessageText").reply_markup as { inline_keyboard: { text: string }[][] };
    expect(after.inline_keyboard[0]?.[0]?.text).not.toContain("正在回复");
  });

  it("没选人就发消息，提示里能直接点去选", async () => {
    await h.fromUser(ALICE, "hi");
    await h.fromOwner("没选人");
    const hint = h.tg.last("sendMessage");
    expect(String(hint.text)).toContain("没发出去");
    expect(JSON.stringify(hint.reply_markup)).toContain("list:0");
  });

  it("收到回执：只在一波消息的第一条发，冷却期内不重复", async () => {
    await h.fromUser(ALICE, "1");
    await h.app.db.prepare("UPDATE contacts SET unread = 0 WHERE user_id = ?").bind(ALICE).run();
    h.clock.now += 31 * 86_400;
    await h.fromUser(ALICE, "2");
    await h.fromUser(ALICE, "3");
    await h.app.db.prepare("UPDATE contacts SET unread = 0 WHERE user_id = ?").bind(ALICE).run();
    await h.fromUser(ALICE, "4");
    expect(h.tg.textsTo(ALICE).filter((text) => text === h.app.settings.receipt)).toHaveLength(1);
  });

  it("关键词回复，并计入聊天记录", async () => {
    await h.app.db.prepare("INSERT INTO auto_rules(keywords, reply, created_at) VALUES('价格,多少钱', '价格表：99 元', 1)").run();
    await h.fromUser(ALICE, "请问多少钱呀");
    expect(h.tg.textsTo(ALICE).at(-1)).toBe("价格表：99 元");
    expect((await row("SELECT hits FROM auto_rules")).hits).toBe(1);
    expect(String((await row("SELECT text FROM messages WHERE direction = 'out'")).text)).toContain("价格表");
  });

  it("离线时段发离线回复", async () => {
    await h.set("offlineEnabled", true);
    await h.set("onlineFrom", 0);
    await h.set("onlineTo", 0);
    await h.set("onlineTo", 1);
    h.clock.now = Date.UTC(2027, 0, 1, 6, 0, 0) / 1000; // 北京时间 14 点，不在 0-1 点内
    await h.fromUser(ALICE, "在吗");
    expect(h.tg.textsTo(ALICE).at(-1)).toBe(h.app.settings.offlineMessage);
  });

  it("跨夜在线时段判断正确", async () => {
    await h.set("offlineEnabled", true);
    await h.set("onlineFrom", 22);
    await h.set("onlineTo", 6);
    h.clock.now = Date.UTC(2027, 0, 1, 16, 0, 0) / 1000; // 北京时间 0 点，在线
    await h.fromUser(ALICE, "在吗");
    expect(h.tg.textsTo(ALICE)).not.toContain(h.app.settings.offlineMessage);
  });
});

describe("同步与撤回", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("对方改消息：同步到客服台并留下原文", async () => {
    const id = await h.fromUser(ALICE, "原来的话");
    h.tg.reset();
    await h.send({ edited_message: { message_id: id, date: 0, edit_date: 1, chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false, first_name: "a" }, text: "改过的话" } as never });
    expect(h.tg.last("editMessageText").text).toBe("改过的话");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("原来的话");
    expect((await row("SELECT text FROM messages WHERE user_msg_id = ?", id)).text).toBe("改过的话");
  });

  it("管理员改消息：同步给对方", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    const id = await h.fromOwner("错别字");
    h.tg.reset();
    await h.send({ edited_message: { message_id: id, date: 0, edit_date: 1, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "o" }, text: "正确" } as never });
    expect(h.tg.last("editMessageText")).toMatchObject({ chat_id: ALICE, text: "正确" });
  });

  it("内容没变的编辑不报错", async () => {
    const id = await h.fromUser(ALICE, "同样");
    h.tg.failNext("editMessageText", 400, "Bad Request: message is not modified");
    await h.send({ edited_message: { message_id: id, date: 0, edit_date: 1, chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false, first_name: "a" }, text: "同样" } as never });
    expect((await row("SELECT COUNT(*) AS n FROM messages")).n).toBe(1);
  });

  it("/del 撤回自己发的，不能撤对方的", async () => {
    const userMsg = await h.fromUser(ALICE, "hi");
    const inbound = num((await row("SELECT desk_msg_id FROM messages WHERE user_msg_id = ?", userMsg)).desk_msg_id);
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    const mine = await h.fromOwner("发错了");
    h.tg.reset();
    await h.fromOwner("/del", { reply_to_message: { message_id: mine, chat: { id: OWNER, type: "private" }, date: 0 } });
    expect(h.tg.last("deleteMessage")).toMatchObject({ chat_id: ALICE });
    expect((await row("SELECT retracted_at FROM messages WHERE desk_msg_id = ?", mine)).retracted_at).not.toBeNull();
    h.tg.reset();
    await h.fromOwner("/del", { reply_to_message: { message_id: inbound, chat: { id: OWNER, type: "private" }, date: 0 } });
    expect(h.tg.named("deleteMessage")).toHaveLength(0);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("只能撤回");
  });

  it("表态双向同步", async () => {
    const id = await h.fromUser(ALICE, "hi");
    const desk = num((await row("SELECT desk_msg_id FROM messages WHERE user_msg_id = ?", id)).desk_msg_id);
    h.tg.reset();
    await h.send({ message_reaction: { chat: { id: OWNER, type: "private" }, message_id: desk, date: 0, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } as never });
    expect(h.tg.last("setMessageReaction")).toMatchObject({ chat_id: ALICE, message_id: id });
    h.tg.reset();
    await h.send({ message_reaction: { chat: { id: ALICE, type: "private" }, message_id: id, date: 0, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "❤" }] } as never });
    expect(h.tg.last("setMessageReaction")).toMatchObject({ chat_id: OWNER, message_id: desk });
  });
});

describe("认领和权限", () => {
  it("认领链接一次性，过期无效", async () => {
    h = await makeHarness({ owner: false });
    const { createClaim } = await import("../src/core/setup.ts");
    const code = await createClaim(h.app);
    h.clock.now += 7 * 86_400 + 1;
    await h.fromUser(OWNER, `/start claim_${code}`);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("已失效");
    expect(h.app.settings.ownerId).toBeNull();

    const fresh = await createClaim(h.app);
    await h.fromUser(OWNER, `/start claim_${fresh}`);
    expect(h.app.settings.ownerId).toBe(OWNER);
    await h.fromUser(ALICE, `/start claim_${fresh}`);
    expect(h.app.settings.ownerId).toBe(OWNER);
  });

  it("没绑定管理员时不处理联系人消息", async () => {
    h = await makeHarness({ owner: false, verify: false });
    await h.fromUser(ALICE, "hi");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
  });

  it("陌生人点管理按钮无效", async () => {
    h = await makeHarness({ verify: false });
    await h.fromUser(ALICE, "hi");
    await h.press(ALICE, ALICE, 1, `block:${ALICE}`);
    expect((await row("SELECT blocked_at FROM contacts WHERE user_id = ?", ALICE)).blocked_at).toBeNull();
    await h.press(BOB, OWNER, 1, "clean!:0");
    expect(String((await row("SELECT text FROM messages")).text)).toBe("hi");
  });

  it("群成员不能用主人专属操作", async () => {
    h = await makeHarness({ verify: false });
    await h.set("deskMode", "group");
    await h.set("groupId", GROUP);
    await h.fromUser(ALICE, "hi");
    await h.press(7777, GROUP, 1, "clean!:0");
    expect(String((await row("SELECT text FROM messages")).text)).toBe("hi");
    await h.fromGroup(7777, "/settings", null);
    expect(h.tg.last("sendMessage").text).toContain("只有主人");
  });
});

describe("管理功能", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("设置菜单：开关立即生效，输入会校验", async () => {
    await h.press(OWNER, OWNER, 1, "mt:receiptEnabled");
    expect(h.app.settings.receiptEnabled).toBe(false);
    await h.press(OWNER, OWNER, 1, "mi:messagesPerMinute");
    await h.fromOwner("abc");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("整数");
    await h.fromOwner("10");
    h.app.settings = await (await import("../src/core/settings.ts")).loadSettings(h.app.db);
    expect(h.app.settings.messagesPerMinute).toBe(10);
  });

  it("修改设置时输入的文字不会发给选中的联系人", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    await h.press(OWNER, OWNER, 1, "mi:welcome");
    h.tg.reset();
    await h.fromOwner("新欢迎语");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    await h.fromUser(BOB, "/start");
    expect(h.tg.textsTo(BOB).at(-1)).toBe("新欢迎语");
  });

  it("备注、搜索、列表、记录、统计都能跑", async () => {
    await h.fromUser(ALICE, "hi <b>注入</b>");
    await h.fromOwner(`/note ${ALICE} 老客户`);
    await h.fromOwner("/search 老客户");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("老客户");
    await h.fromOwner("/list");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("最近会话");
    await h.fromOwner(`/history ${ALICE}`);
    const history = h.tg.textsTo(OWNER).at(-1) ?? "";
    expect(history).toContain("&lt;b&gt;注入");
    await h.fromOwner("/stats");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("收到 1");
  });

  it("联系人的名字含 HTML 也不会破坏卡片", async () => {
    await h.send({ message: { message_id: 1, date: 0, chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false, first_name: "<script>&" }, text: "x" } as never });
    expect(h.tg.textsTo(OWNER)[0]).toContain("&lt;script&gt;&amp;");
  });

  it("快捷回复：发给对方，并能撤回", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    await h.fromOwner("/qadd 价格 99 元一个月");
    h.tg.reset();
    await h.fromOwner("/q 价格");
    expect(h.tg.named("sendMessage").find((params) => params.chat_id === ALICE)?.text).toBe("99 元一个月");
    expect((await row("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'")).n).toBe(1);
  });

  it("群发：分批、跳过屏蔽和不可达、完成报告、可取消", async () => {
    for (let id = 3000; id < 3030; id++) {
      await h.app.db.prepare("INSERT INTO contacts(user_id, first_seen, last_seen, msg_count) VALUES(?, 1, 1, 1)").bind(id).run();
    }
    await h.app.db.prepare("UPDATE contacts SET blocked_at = 1 WHERE user_id = 3000").run();
    await h.app.db.prepare("UPDATE contacts SET unreachable_at = 1 WHERE user_id = 3001").run();
    const source = await h.fromOwner("公告内容", {});
    await h.fromOwner("/broadcast", { reply_to_message: { message_id: source, chat: { id: OWNER, type: "private" }, date: 0 } });
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("28 个联系人");
    const job = await row("SELECT id FROM broadcasts");
    await h.press(OWNER, OWNER, 1, `bc_go:${num(job.id)}`);
    h.tg.reset();
    h.tg.failNext("copyMessage", 403, "Forbidden: bot was blocked by the user");
    await h.deferred.run();
    expect(h.tg.named("copyMessage")).toHaveLength(25);
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === 3000 || params.chat_id === 3001)).toBe(false);
    const { broadcastTick } = await import("../src/core/maintenance.ts");
    await broadcastTick(h.app);
    expect(h.tg.named("copyMessage")).toHaveLength(28);
    await broadcastTick(h.app);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("成功 27，失败 1");
    expect((await row("SELECT state FROM broadcasts")).state).toBe("done");
    expect((await row("SELECT COUNT(*) AS n FROM contacts WHERE unreachable_at IS NOT NULL")).n).toBe(2);
  });

  it("确认后的立即执行撞上定时任务，不会重复发", async () => {
    for (let id = 3000; id < 3010; id++) await h.app.db.prepare("INSERT INTO contacts(user_id, first_seen, last_seen, msg_count) VALUES(?, 1, 1, 1)").bind(id).run();
    await h.app.db.prepare("INSERT INTO broadcasts(from_chat_id, from_msg_id, report_chat_id, state, created_at) VALUES(1000, 1, 1000, 'running', 1)").run();
    const { broadcastTick } = await import("../src/core/maintenance.ts");
    await Promise.all([broadcastTick(h.app), broadcastTick(h.app)]);
    const targets = h.tg.named("copyMessage").map((params) => params.chat_id);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toHaveLength(10);
  });

  it("群发进程中途崩溃，租约过期后能继续", async () => {
    await h.app.db.prepare("INSERT INTO contacts(user_id, first_seen, last_seen, msg_count) VALUES(3000, 1, 1, 1)").run();
    await h.app.db.prepare("INSERT INTO broadcasts(from_chat_id, from_msg_id, report_chat_id, state, created_at, locked_until) VALUES(1000, 1, 1000, 'running', 1, ?)").bind(h.clock.now + 60).run();
    const { broadcastTick } = await import("../src/core/maintenance.ts");
    await broadcastTick(h.app);
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    h.clock.now += 61;
    await broadcastTick(h.app);
    expect(h.tg.named("copyMessage")).toHaveLength(1);
  });

  it("超长和全是特殊字符的内容，历史、隔离区、菜单、编辑通知都发得出去", async () => {
    const nasty = "&<>\"".repeat(1500);
    await h.set("blockedKeywords", ["&"]);
    for (let id = 0; id < 12; id++) await h.fromUser(ALICE, nasty);
    await h.fromOwner(`/history ${ALICE}`);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain(`${ALICE}`);
    await h.fromOwner("/filtered");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("隔离区");
    const failures = () => h.tg.calls.length;
    expect(failures()).toBeGreaterThan(0);

    await h.set("blockedKeywords", []);
    await h.set("welcome", nasty.slice(0, 2000));
    await h.set("receipt", nasty.slice(0, 2000));
    await h.set("offlineMessage", nasty.slice(0, 2000));
    await h.fromOwner("/settings");
    await h.press(OWNER, OWNER, 1, "m:auto");
    expect(String(h.tg.last("editMessageText").text)).toContain("自动回复");

    await h.fromOwner(`/note ${ALICE} ${"&".repeat(500)}`);
    await h.fromOwner(`/search ${ALICE}`);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("备注");

    const id = await h.fromUser(BOB, "短消息");
    await h.app.db.prepare("UPDATE messages SET text = ? WHERE user_msg_id = ?").bind(nasty, id).run();
    await h.send({ edited_message: { message_id: id, date: 0, edit_date: 1, chat: { id: BOB, type: "private" }, from: { id: BOB, is_bot: false, first_name: "b" }, text: "改了" } as never });
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("原文");
  });

  it("名字和内容里的 HTML 不会让隔离区、记录打不开", async () => {
    await h.set("blockedKeywords", ["x"]);
    await h.send({ message: { message_id: 1, date: 0, chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false, first_name: "<b>&" }, text: "x <i>" } as never });
    await h.fromOwner("/filtered");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("&lt;i&gt;");
    await h.fromOwner(`/history ${ALICE}`);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("&lt;i&gt;");
  });

  it("群发被限流时停在原地，下一轮继续，不跳人", async () => {
    await h.app.db.prepare("INSERT INTO contacts(user_id, first_seen, last_seen, msg_count) VALUES(3000, 1, 1, 1), (3001, 1, 1, 1)").run();
    await h.app.db.prepare("INSERT INTO broadcasts(from_chat_id, from_msg_id, report_chat_id, state, created_at) VALUES(1000, 1, 1000, 'running', 1)").run();
    const { broadcastTick } = await import("../src/core/maintenance.ts");
    h.tg.failNext("copyMessage", 429, "Too Many Requests", 60);
    await broadcastTick(h.app);
    h.tg.reset();
    await broadcastTick(h.app);
    expect(h.tg.named("copyMessage").map((params) => params.chat_id)).toEqual([3000, 3001]);
  });

  it("清理只抹内容，回复映射还在，老消息依然能回复", async () => {
    await h.fromUser(ALICE, "秘密");
    const desk = num((await row("SELECT desk_msg_id FROM messages")).desk_msg_id);
    await h.press(OWNER, OWNER, 1, "clean!:0");
    expect((await row("SELECT text FROM messages")).text).toBeNull();
    h.tg.reset();
    await h.fromOwner("回复老消息", { reply_to_message: { message_id: desk, chat: { id: OWNER, type: "private" }, date: 0 } });
    expect(h.tg.last("copyMessage")).toMatchObject({ chat_id: ALICE });
  });

  it("每日清理按保留期抹内容，一天只跑一次", async () => {
    await h.fromUser(ALICE, "旧消息");
    const { dailyCleanup } = await import("../src/core/maintenance.ts");
    h.clock.now += 181 * 86_400;
    await dailyCleanup(h.app);
    expect((await row("SELECT text FROM messages")).text).toBeNull();
    expect(h.app.settings.lastMaintenanceDay).not.toBe("");
  });

  it("导出生成 JSON 文件", async () => {
    await h.fromUser(ALICE, "hi");
    await h.fromOwner("/export");
    expect(h.tg.last("sendDocument").chat_id).toBe(OWNER);
  });

  it("在群里导出也只发到主人私聊，不把聊天记录发进群", async () => {
    await h.set("deskMode", "group");
    await h.set("groupId", GROUP);
    await h.fromUser(ALICE, "hi");
    await h.fromGroup(OWNER, "/export", null);
    expect(h.tg.last("sendDocument").chat_id).toBe(OWNER);
  });

  it("一条坏更新不会抛出，后面的更新继续处理", async () => {
    h.tg.failNext("sendMessage", 500, "Internal");
    h.tg.failNext("copyMessage", 500, "Internal");
    await h.fromUser(ALICE, "hi");
    await h.fromUser(ALICE, "hi2");
    expect(h.tg.named("copyMessage").length).toBeGreaterThan(0);
  });
});

describe("管理面板：不打命令也能管理", () => {
  type Row = { text: string; callback_data?: string; url?: string }[];
  const buttons = (params: Record<string, unknown>): Row[number][] => ((params.reply_markup as { inline_keyboard: Row[] } | undefined)?.inline_keyboard ?? []).flat();
  const labels = (params: Record<string, unknown>) => buttons(params).map((button) => button.text);
  const dataOf = (params: Record<string, unknown>, text: string) => {
    const found = buttons(params).find((button) => button.text.includes(text))?.callback_data;
    if (!found) throw new Error(`没有按钮「${text}」，实际：${labels(params).join("、")}`);
    return found;
  };

  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("主人发 /start 看到面板，能点到全部管理功能", async () => {
    await h.fromOwner("/start");
    const home = labels(h.tg.last("sendMessage")).join("、");
    for (const name of ["最近会话", "搜索联系人", "快捷回复", "隔离区", "群发", "统计", "设置", "更多"]) expect(home).toContain(name);
    for (const button of buttons(h.tg.last("sendMessage"))) expect(new TextEncoder().encode(button.callback_data ?? "").length).toBeLessThanOrEqual(64);
    await h.press(OWNER, OWNER, 1, "p:more");
    const more = labels(h.tg.last("editMessageText")).join("、");
    for (const name of ["关键词回复", "已屏蔽", "清理记录", "导出数据", "运行状态", "返回首页"]) expect(more).toContain(name);
    expect(home).not.toContain("导出数据");
  });

  it("欢迎语从设置第一页就能改，不用再进一层", async () => {
    await h.press(OWNER, OWNER, 1, "m:main");
    expect(dataOf(h.tg.last("editMessageText"), "第一次自动回复")).toBe("mi:welcome");
  });

  it("陌生人发 /start 看不到面板，按面板按钮也没有反应", async () => {
    await h.fromUser(ALICE, "/start");
    expect(h.tg.textsTo(ALICE).join()).not.toContain("管理面板");
    h.tg.reset();
    await h.press(ALICE, ALICE, 1, "ex");
    await h.press(ALICE, ALICE, 1, "qm:0");
    expect(h.tg.named("editMessageText")).toHaveLength(0);
    expect(h.tg.calls.filter((call) => call.method === "sendDocument")).toHaveLength(0);
  });

  it("认领成功后直接给面板", async () => {
    h = await makeHarness({ verify: false, owner: false });
    await h.set("claimCode", "abc");
    await h.set("claimExpiresAt", h.clock.now + 100);
    await h.fromUser(OWNER, "/start claim_abc");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("管理面板");
  });

  it("命令菜单只留入口，打完整命令还能用", async () => {
    h = await makeHarness({ verify: false, owner: false });
    await h.set("claimCode", "abc");
    await h.set("claimExpiresAt", h.clock.now + 100);
    await h.fromUser(OWNER, "/start claim_abc");
    const owner = h.tg.named("setMyCommands").find((params) => params.scope !== undefined);
    expect((owner?.commands as { command: string }[]).map((item) => item.command)).toEqual(["menu", "help"]);
    await h.fromOwner("/stats");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("今天");
  });

  it("点按钮添加快捷回复，点联系人卡片发出去，再点按钮删除", async () => {
    await h.fromUser(ALICE, "你好");
    await h.press(OWNER, OWNER, 1, "qa");
    await h.fromOwner("价格");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("价格");
    await h.fromOwner("99 元一个月 <b>");
    expect((await row("SELECT body FROM quick_replies WHERE name = '价格'")).body).toBe("99 元一个月 <b>");

    await h.press(OWNER, OWNER, 1, `qp:${ALICE}`);
    const picker = h.tg.last("sendMessage");
    h.tg.reset();
    await h.press(OWNER, OWNER, 9, dataOf(picker, "价格"));
    expect(h.tg.textsTo(ALICE)).toEqual(["99 元一个月 <b>"]);
    expect(num((await row("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND user_id = ?", ALICE)).n)).toBe(1);
    expect(String(h.tg.last("editMessageText").text)).toContain("已发给");

    await h.press(OWNER, OWNER, 1, "qm:0");
    const view = dataOf(h.tg.last("editMessageText"), "价格");
    await h.press(OWNER, OWNER, 1, view);
    await h.press(OWNER, OWNER, 1, dataOf(h.tg.last("editMessageText"), "删除"));
    expect(num((await row("SELECT COUNT(*) AS n FROM quick_replies")).n)).toBe(0);
  });

  it("还没有快捷回复时，卡片上的按钮引导去添加", async () => {
    await h.fromUser(ALICE, "你好");
    await h.press(OWNER, OWNER, 1, `qp:${ALICE}`);
    expect(labels(h.tg.last("sendMessage"))).toEqual(["➕ 添加快捷回复"]);
  });

  it("点按钮添加关键词回复，立刻生效，也能点按钮删除", async () => {
    await h.press(OWNER, OWNER, 1, "ra");
    await h.fromOwner("价格,多少钱");
    await h.fromOwner("价格表：99 元");
    await h.fromUser(ALICE, "这个多少钱");
    expect(h.tg.textsTo(ALICE)).toContain("价格表：99 元");
    await h.press(OWNER, OWNER, 1, "rl:0");
    await h.press(OWNER, OWNER, 1, dataOf(h.tg.last("editMessageText"), "价格"));
    await h.press(OWNER, OWNER, 1, dataOf(h.tg.last("editMessageText"), "删除"));
    expect(num((await row("SELECT COUNT(*) AS n FROM auto_rules")).n)).toBe(0);
  });

  it("点按钮群发：发图片也行，确认前不会发出去", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, "bc");
    h.tg.reset();
    await h.fromOwner(undefined as never, { photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] });
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("1 个联系人");
    expect((await row("SELECT state FROM broadcasts")).state).toBe("draft");
    await h.press(OWNER, OWNER, 1, dataOf(h.tg.last("sendMessage"), "确认"));
    await h.deferred.run();
    expect(h.tg.named("copyMessage").filter((params) => params.chat_id === ALICE).length + h.tg.named("copyMessages").filter((params) => params.chat_id === ALICE).length).toBe(1);
  });

  it("点按钮搜索联系人", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, "srch");
    h.tg.reset();
    await h.fromOwner("u2001");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("用户2001");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    await h.press(OWNER, OWNER, 1, "srch");
    await h.fromOwner("没有这个人");
    expect(h.tg.textsTo(OWNER).at(-1)).toBe("没找到。");
  });

  it("已屏蔽列表能点按钮解除", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `block:${ALICE}`);
    await h.press(OWNER, OWNER, 1, "bk:0");
    await h.press(OWNER, OWNER, 1, dataOf(h.tg.last("editMessageText"), "解除屏蔽"));
    expect((await row("SELECT blocked_at FROM contacts WHERE user_id = ?", ALICE)).blocked_at).toBeNull();
    expect(String(h.tg.last("editMessageText").text)).toContain("没有屏蔽");
  });

  it("卡片上能撤回发出去的最后一条，先确认", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    await h.fromOwner("发错了");
    h.tg.reset();
    await h.press(OWNER, OWNER, 1, `undo:${ALICE}`);
    expect(h.tg.named("deleteMessage")).toHaveLength(0);
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("发错了");
    await h.press(OWNER, OWNER, 9, dataOf(h.tg.last("sendMessage"), "确认撤回"));
    expect(h.tg.last("deleteMessage").chat_id).toBe(ALICE);
    expect(String(h.tg.last("editMessageText").text)).toContain("已撤回");
    await h.press(OWNER, OWNER, 1, `undo:${ALICE}`);
    expect(h.tg.last("answerCallbackQuery").text).toContain("没有可以撤回");
  });

  it("取消按钮：之后发的话照常发给客户，不会被当成输入", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    await h.press(OWNER, OWNER, 1, "mi:welcome");
    expect(labels(h.tg.last("sendMessage"))).toEqual(["❌ 取消"]);
    await h.press(OWNER, OWNER, 9, "cancel");
    expect(String(h.tg.last("editMessageText").text)).toBe("已取消。");
    h.tg.reset();
    await h.fromOwner("给客户的话");
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === ALICE)).toBe(true);
    await h.fromUser(BOB, "/start");
    expect(h.tg.textsTo(BOB).at(-1)).not.toBe("给客户的话");
  });

  it("点了提问又去点别的按钮，等于放弃这一步", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    await h.press(OWNER, OWNER, 1, "mi:welcome");
    await h.press(OWNER, OWNER, 1, "p:main");
    h.tg.reset();
    await h.fromOwner("给客户的话");
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === ALICE)).toBe(true);
    await h.fromUser(BOB, "/start");
    expect(h.tg.textsTo(BOB).at(-1)).not.toBe("给客户的话");
  });

  it("点了提问又打了命令，也等于放弃这一步", async () => {
    await h.press(OWNER, OWNER, 1, "qa");
    await h.fromOwner("/stats");
    expect(h.tg.textsTo(OWNER).at(-1)).toContain("今天");
    await h.fromOwner("随便一句");
    expect(num((await row("SELECT COUNT(*) AS n FROM staff_state WHERE awaiting IS NOT NULL")).n)).toBe(0);
  });

  it("每个页面都能回到面板", async () => {
    for (const data of ["p:more", "list:0", "filtered:0", "bk:0", "qm:0", "rl:0", "p:stats", "p:status", "p:help", "cl"]) {
      await h.press(OWNER, OWNER, 1, data);
      expect(buttons(h.tg.last("editMessageText")).some((button) => button.callback_data === "p:main"), data).toBe(true);
    }
    await h.press(OWNER, OWNER, 1, "m:main");
    expect(buttons(h.tg.last("editMessageText")).some((button) => button.callback_data === "p:main")).toBe(true);
  });

  it("点清理记录走确认，导出发给主人", async () => {
    await h.fromUser(ALICE, "hi");
    await h.press(OWNER, OWNER, 1, "cl");
    await h.press(OWNER, OWNER, 1, dataOf(h.tg.last("editMessageText"), "全部"));
    expect(String(h.tg.last("editMessageText").text)).toContain("不能恢复");
    await h.press(OWNER, OWNER, 1, dataOf(h.tg.last("editMessageText"), "确认清理"));
    expect(String(h.tg.last("editMessageText").text)).toContain("已清理");
    await h.press(OWNER, OWNER, 1, "ex");
    expect(h.tg.last("sendDocument").chat_id).toBe(OWNER);
  });

  it("设置里的绑定话题群是一个拉群链接", async () => {
    await h.set("botUsername", "demo_bot");
    await h.press(OWNER, OWNER, 1, "m:desk");
    const link = buttons(h.tg.last("editMessageText")).find((button) => button.url)?.url;
    expect(link).toBe("https://t.me/demo_bot?startgroup=bind&admin=manage_topics");
  });

  it("通过拉群链接进群后，/start bind 会走绑定检查；别的群里的普通 /start 不理", async () => {
    await h.set("botUsername", "demo_bot");
    h.tg.responses.set("getChat", { is_forum: true });
    h.tg.responses.set("getChatMember", { status: "administrator", can_manage_topics: true });
    await h.fromGroup(7777, "/start@demo_bot", null);
    expect(h.tg.named("getChat")).toHaveLength(0);
    await h.fromGroup(OWNER, "/start@demo_bot bind", null);
    expect(h.app.settings.deskMode).toBe("group");
    expect(h.app.settings.groupId).toBe(GROUP);
  });

  describe("话题群里的同事", () => {
    beforeEach(async () => {
      await h.set("deskMode", "group");
      await h.set("groupId", GROUP);
    });

    it("面板里没有主人专属的按钮，硬点也被拒绝", async () => {
      await h.fromGroup(7777, "/menu", null);
      const shown = labels(h.tg.last("sendMessage")).join("、");
      expect(shown).toContain("快捷回复");
      for (const name of ["群发", "设置", "更多", "导出数据", "清理记录", "运行状态", "关键词回复"]) expect(shown).not.toContain(name);
      expect(shown).toContain("已屏蔽");
      h.tg.reset();
      for (const data of ["ex", "bc", "bcx", "cl", "rl:0", "ra", "rd:1", "p:status", "p:more"]) {
        await h.press(7777, GROUP, 1, data);
      }
      expect(h.tg.named("sendDocument")).toHaveLength(0);
      expect(h.tg.named("sendMessage")).toHaveLength(0);
      expect(h.tg.named("editMessageText")).toHaveLength(0);
    });

    it("提问发到当前话题，回答也在话题里", async () => {
      await h.press(7777, GROUP, 1, "qa", 55);
      expect(h.tg.last("sendMessage").message_thread_id).toBe(55);
      await h.fromGroup(7777, "你好", 55);
      await h.fromGroup(7777, "你好呀", 55);
      expect((await row("SELECT body FROM quick_replies WHERE name = '你好'")).body).toBe("你好呀");
      expect(h.tg.last("sendMessage").message_thread_id).toBe(55);
    });
  });

  describe("首次绑定：点配对图案成为管理员", () => {
    // 假随机总取最小值，所以配对的是第 0 个图案
    const RIGHT = "claim:0";
    const WRONG = "claim:1";

    beforeEach(async () => {
      h = await makeHarness({ verify: false, owner: false });
      await createClaim(h.app);
    });

    it("打开机器人有 6 个图案，点对成为管理员并收到面板，窗口关闭", async () => {
      await h.fromUser(OWNER, "/start");
      const shown = labels(h.tg.last("sendMessage"));
      expect(shown).toHaveLength(6);
      expect(new Set(shown).size).toBe(6);
      expect(shown).toContain(CLAIM_PAIRS[0]);
      await h.press(OWNER, OWNER, 9, dataOf(h.tg.last("sendMessage"), CLAIM_PAIRS[0] ?? ""));
      expect(h.app.settings.ownerId).toBe(OWNER);
      expect(h.app.settings.claimExpiresAt).toBe(0);
      expect(h.app.settings.claimPair).toBe("");
      expect(h.tg.textsTo(OWNER).join()).toContain("绑定成功");
      expect(h.tg.textsTo(OWNER).at(-1)).toContain("管理面板");
      expect(num((await row("SELECT COUNT(*) AS n FROM contacts")).n)).toBe(0);
    });

    it("多看几次选项也不变，取交集算不出答案", async () => {
      const seen = new Set<string>();
      const random = h.app.rng;
      let n = 0;
      h.app.rng = { ...random, int: (min, max) => min + (n++ % (max - min + 1)) };
      for (let index = 0; index < 8; index++) {
        await h.fromUser(ALICE, "/start");
        seen.add(labels(h.tg.last("sendMessage")).join());
      }
      expect(seen.size).toBe(1);
    });

    it("按钮和提示里都不泄露哪个是对的", async () => {
      await h.fromUser(ALICE, "/start");
      const prompt = h.tg.last("sendMessage");
      expect(String(prompt.text)).not.toContain(h.app.settings.claimPair);
      for (const button of buttons(prompt)) expect(button.callback_data).toMatch(/^claim:\d+$/);
    });

    it("点错一次按钮就失效，点对的人也进不来了", async () => {
      await h.press(ALICE, ALICE, 9, WRONG);
      await h.send({});
      expect(h.app.settings.ownerId).toBeNull();
      expect(String(h.tg.last("editMessageText").text)).toContain("图案不对");
      await h.press(ALICE, ALICE, 9, RIGHT);
      await h.send({});
      expect(h.app.settings.ownerId).toBeNull();
      await h.fromUser(BOB, "/start");
      expect(labels(h.tg.last("sendMessage"))).toEqual([]);
    });

    it("别人故意点错后，部署的人用链接还能绑定", async () => {
      await h.press(ALICE, ALICE, 9, WRONG);
      await h.fromUser(OWNER, `/start claim_${h.app.settings.claimCode}`);
      await h.send({});
      expect(h.app.settings.ownerId).toBe(OWNER);
    });

    it("重新生成后按钮又能用了", async () => {
      await h.press(ALICE, ALICE, 9, WRONG);
      await h.send({});
      await createClaim(h.app);
      await h.press(OWNER, OWNER, 9, RIGHT);
      await h.send({});
      expect(h.app.settings.ownerId).toBe(OWNER);
    });

    it("乱写的按钮数据算点错", async () => {
      for (const data of ["claim", "claim:99", "claim:abc"]) {
        await createClaim(h.app);
        await h.press(ALICE, ALICE, 9, data);
        await h.send({});
        expect(h.app.settings.ownerId, data).toBeNull();
      }
    });

    it("已经绑定后别人再点没有用", async () => {
      await h.press(OWNER, OWNER, 9, RIGHT);
      await h.press(ALICE, ALICE, 9, RIGHT);
      await h.send({});
      expect(h.app.settings.ownerId).toBe(OWNER);
      expect(String(h.tg.last("editMessageText").text)).toContain("失效");
      h.tg.reset();
      await h.fromUser(BOB, "/start");
      expect(h.tg.textsTo(BOB).join()).not.toContain("管理员");
    });

    it("超过时限按钮失效，也不再显示", async () => {
      h.clock.now += 7 * 86_400 + 1;
      await h.press(ALICE, ALICE, 9, RIGHT);
      await h.send({});
      expect(h.app.settings.ownerId).toBeNull();
      h.tg.reset();
      await h.fromUser(ALICE, "/start");
      expect(h.tg.textsTo(ALICE).at(-1)).toContain("设置中");
      expect(labels(h.tg.last("sendMessage"))).toEqual([]);
    });

    it("已有管理员时生成新链接也不会出现按钮，换人只能走链接", async () => {
      await h.set("ownerId", OWNER);
      await createClaim(h.app);
      await h.press(ALICE, ALICE, 9, RIGHT);
      await h.send({});
      expect(h.app.settings.ownerId).toBe(OWNER);
      await h.fromUser(ALICE, "/start");
      expect(h.tg.textsTo(ALICE).join()).not.toContain("配对");
      await h.fromUser(ALICE, `/start claim_${h.app.settings.claimCode}`);
      await h.send({});
      expect(h.app.settings.ownerId).toBe(ALICE);
      expect(h.tg.textsTo(OWNER).at(-1)).toContain("已被更换");
    });

    it("朋友模式：谁先点算谁，一个按钮，不用图案和链接", async () => {
      await createClaim(h.app, { mode: "open" });
      await h.fromUser(ALICE, "你好");
      expect(labels(h.tg.last("sendMessage"))).toEqual(["👑 成为管理员"]);
      await h.press(ALICE, ALICE, 9, dataOf(h.tg.last("sendMessage"), "成为管理员"));
      await h.send({});
      expect(h.app.settings.ownerId).toBe(ALICE);
      expect(h.app.settings.ownerName).toContain("用户2001");
      await h.press(BOB, BOB, 9, "claim");
      await h.send({});
      expect(h.app.settings.ownerId).toBe(ALICE);
    });

    it("指定用户名：他私聊就直接成为管理员，不用点按钮和图案，大小写不敏感", async () => {
      await createClaim(h.app, { mode: "user", user: "u2001" });
      await h.fromUser(ALICE, "你好");
      await h.send({});
      expect(h.app.settings.ownerId).toBe(ALICE);
      expect(h.tg.textsTo(ALICE).join()).toContain("绑定成功");
      expect(h.tg.textsTo(ALICE).at(-1)).toContain("管理面板");
      expect(h.app.settings.claimExpiresAt).toBe(0);
      await h.press(BOB, BOB, 9, "claim");
      await h.send({});
      expect(h.app.settings.ownerId).toBe(ALICE);
    });

    it("指定用户名：别人私聊没有按钮，点旧按钮也没用，抢不走", async () => {
      await createClaim(h.app, { mode: "user", user: "u2001" });
      await h.fromUser(BOB, "/start");
      expect(h.tg.textsTo(BOB).join()).not.toContain("成为管理员");
      expect(labels(h.tg.last("sendMessage"))).toEqual([]);
      await h.press(BOB, BOB, 9, "claim");
      await h.send({});
      expect(h.app.settings.ownerId).toBeNull();
    });

    it("朋友没设用户名时，指定模式不会误绑", async () => {
      await createClaim(h.app, { mode: "user", user: "u2001" });
      await h.send({ message: { message_id: 1, date: 1, chat: { id: 7777, type: "private" }, from: { id: 7777, is_bot: false, first_name: "无用户名" }, text: "/start" } } as never);
      await h.send({});
      expect(h.app.settings.ownerId).toBeNull();
    });

    it("第一次绑定 7 天内有效；已有管理员时的换人链接只有 10 分钟", async () => {
      await createClaim(h.app, { mode: "open" });
      expect(h.app.settings.claimExpiresAt).toBe(h.clock.now + 7 * 86_400);
      await h.set("ownerId", OWNER);
      await createClaim(h.app);
      expect(h.app.settings.claimExpiresAt).toBe(h.clock.now + 600);
    });

    it("群里的按钮不算", async () => {
      await h.press(ALICE, GROUP, 9, RIGHT);
      await h.send({});
      expect(h.app.settings.ownerId).toBeNull();
      expect(h.app.settings.claimPair).not.toBe("");
    });

    it("日志里去掉名字中的控制字符，点错也记下是谁", async () => {
      const logged: string[] = [];
      h.app.log = (_level, message, detail) => {
        logged.push(`${message}：${String(detail)}`);
      };
      const press = (data: string) =>
        h.send({ callback_query: { id: "c", from: { id: OWNER, is_bot: false, first_name: "假\n已绑定管理员：别人\u001b[2J" }, chat_instance: "x", data, message: { message_id: 9, date: 1, chat: { id: OWNER, type: "private" } } } } as never);
      await press(WRONG);
      await createClaim(h.app);
      await press(RIGHT);
      expect(logged.some((item) => item.startsWith("绑定按钮已失效"))).toBe(true);
      expect(logged.some((item) => item.startsWith("已绑定管理员"))).toBe(true);
      for (const item of logged) expect(item).not.toMatch(/\p{Cc}/u);
    });
  });
});

describe("验证题：10 以内加减，三个选项", () => {
  it("随机生成一千次，答案在 0 到 10 之间，三个选项不重复且含正确答案", () => {
    for (let index = 0; index < 1000; index++) {
      const challenge = makeChallenge(cryptoRng);
      const match = /^(\d+) ([+-]) (\d+) 等于几？$/.exec(challenge.question);
      if (!match) throw new Error(`题目格式不对：${challenge.question}`);
      const [a, b] = [Number(match[1]), Number(match[3])];
      const answer = match[2] === "+" ? a + b : a - b;
      expect(String(answer)).toBe(challenge.correct);
      expect(answer).toBeGreaterThanOrEqual(0);
      expect(answer).toBeLessThanOrEqual(10);
      expect(a).toBeLessThanOrEqual(10);
      expect(b).toBeLessThanOrEqual(10);
      expect(new Set(challenge.options).size).toBe(3);
      expect(challenge.options).toContain(challenge.correct);
      for (const option of challenge.options) expect(Number(option)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("换管理员", () => {
  const assign = async (user: string) => {
    // 和网页、命令行走的是同一段清理逻辑
    await h.app.db.prepare("DELETE FROM settings WHERE key IN ('ownerId', 'ownerName', 'ownerUsername', 'deskMode', 'groupId')").run();
    await h.app.db.prepare("UPDATE contacts SET thread_id = NULL, thread_claim_at = NULL").run();
    await h.app.db.prepare("DELETE FROM staff_state").run();
    h.app.settings = await loadSettings(h.app.db);
    await createClaim(h.app, { mode: "user", user });
  };

  beforeEach(async () => {
    h = await makeHarness({ verify: false });
    await h.set("deskMode", "group");
    await h.set("groupId", GROUP);
  });

  it("用链接换人后，旧话题群不再收消息，也不能再回复", async () => {
    await h.fromUser(ALICE, "在旧群");
    await h.set("deskMode", "group");
    const code = await createClaim(h.app);
    await h.fromUser(BOB, `/start claim_${code}`);
    await h.send({});
    expect(h.app.settings.ownerId).toBe(BOB);
    expect(h.app.settings.deskMode).toBe("dm");
    expect(h.app.settings.groupId).toBeNull();
    h.tg.reset();
    await h.fromUser(ALICE, "换人后");
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === BOB)).toBe(true);
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === GROUP)).toBe(false);
    h.tg.reset();
    await h.fromGroup(7777, `/history ${ALICE}`, null);
    expect(h.tg.calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });

  it("空档期客户的消息存着，新管理员绑定后转过去", async () => {
    await h.set("deskMode", "dm");
    await h.set("groupId", null);
    await h.fromUser(ALICE, "第一条");
    await h.app.db.prepare("UPDATE contacts SET verified_at = 1").run();
    await assign("u2002");
    h.tg.reset();
    await h.fromUser(ALICE, "空档里的话");
    expect(h.tg.textsTo(ALICE).at(-1)).toContain("消息已保存");
    await h.fromUser(ALICE, "第二句");
    expect(h.tg.textsTo(ALICE).filter((text) => text.includes("消息已保存"))).toHaveLength(1);
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    await h.fromUser(BOB, "我来了");
    await h.send({});
    expect(h.app.settings.ownerId).toBe(BOB);
    expect(h.tg.named("copyMessage").filter((params) => params.chat_id === BOB).length).toBe(2);
  });

  it("换人后对方编辑旧消息，不再发给旧管理员；被屏蔽的人编辑也不打扰", async () => {
    await h.set("deskMode", "dm");
    await h.set("groupId", null);
    const id = await h.fromUser(ALICE, "原话");
    await h.app.db.prepare("UPDATE contacts SET verified_at = 1").run();
    await assign("u2002");
    await h.fromUser(BOB, "我来了");
    await h.send({});
    h.tg.reset();
    const edited = { message_id: id, date: 1, edit_date: 2, chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false, first_name: "x" }, text: "改过" };
    await h.send({ edited_message: edited } as never);
    expect(h.tg.named("editMessageText")).toHaveLength(0);
    expect(h.tg.textsTo(OWNER)).toEqual([]);
    expect((await row("SELECT text FROM messages WHERE user_msg_id = ?", id)).text).toBe("改过");
  });
});

describe("名字里的表情", () => {
  it("按钮文字不会把表情切成半个", async () => {
    h = await makeHarness({ verify: false });
    await h.send({ message: { message_id: 1, date: 1, chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false, first_name: `${"名".repeat(39)}😀😀` }, text: "hi" } } as never);
    await h.press(OWNER, OWNER, 1, "list:0");
    const text = (h.tg.last("editMessageText").reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard[0]?.[0]?.text ?? "";
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("等待输入不能吞掉给客户的话", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("点了改欢迎语，再长按回复客户：发给客户，欢迎语不变", async () => {
    await h.fromUser(ALICE, "你好");
    const copy = h.tg.calls.filter((call) => call.method === "copyMessage").at(-1);
    expect(copy).toBeDefined();
    const row2 = await row("SELECT desk_msg_id FROM messages WHERE user_id = ?", ALICE);
    const welcome = h.app.settings.welcome;
    await h.press(OWNER, OWNER, 1, "mi:welcome");
    h.tg.reset();
    await h.fromOwner("给客户的回复", { reply_to_message: { message_id: num(row2.desk_msg_id), date: 1, chat: { id: OWNER, type: "private" } } });
    await h.send({});
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === ALICE)).toBe(true);
    expect(h.app.settings.welcome).toBe(welcome);
  });

  it("回复机器人的提问，算回答，不算回复客户", async () => {
    await h.press(OWNER, OWNER, 1, "mi:welcome");
    const prompt = 9999;
    await h.fromOwner("新欢迎语", { reply_to_message: { message_id: prompt, date: 1, chat: { id: OWNER, type: "private" } } });
    await h.send({});
    expect(h.app.settings.welcome).toBe("新欢迎语");
  });

  it("在私聊点的提问，去话题里发的话不算输入", async () => {
    await h.set("deskMode", "group");
    await h.set("groupId", GROUP);
    const welcome = h.app.settings.welcome;
    await h.press(OWNER, OWNER, 1, "mi:welcome");
    await h.fromGroup(OWNER, "这是在话题里说的", 55);
    await h.send({});
    expect(h.app.settings.welcome).toBe(welcome);
  });

  it("在 A 的话题点加备注，去 B 的话题发的话不写进 A 的备注", async () => {
    await h.set("deskMode", "group");
    await h.set("groupId", GROUP);
    await h.fromUser(ALICE, "a");
    await h.fromUser(BOB, "b");
    const threadA = num((await row("SELECT thread_id FROM contacts WHERE user_id = ?", ALICE)).thread_id);
    const threadB = num((await row("SELECT thread_id FROM contacts WHERE user_id = ?", BOB)).thread_id);
    await h.press(7777, GROUP, 1, `note:${ALICE}`, threadA);
    h.tg.reset();
    await h.fromGroup(7777, "给 B 的回复", threadB);
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === BOB)).toBe(true);
    expect((await row("SELECT note FROM contacts WHERE user_id = ?", ALICE)).note).toBe("");
  });

  it("匿名管理员写备注：写进备注，不发给客户", async () => {
    await h.set("deskMode", "group");
    await h.set("groupId", GROUP);
    await h.fromUser(ALICE, "a");
    const thread = num((await row("SELECT thread_id FROM contacts WHERE user_id = ?", ALICE)).thread_id);
    await h.press(7777, GROUP, 1, `note:${ALICE}`, thread);
    h.tg.reset();
    await h.send({ message: { message_id: 500, date: 1, chat: { id: GROUP, type: "supergroup", is_forum: true }, sender_chat: { id: GROUP, type: "supergroup" }, from: { id: 1087968824, is_bot: true, first_name: "Group" }, message_thread_id: thread, is_topic_message: true, text: "这人是骗子" } } as never);
    expect((await row("SELECT note FROM contacts WHERE user_id = ?", ALICE)).note).toBe("这人是骗子");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
  });
});

describe("按钮和补发的边界", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("选中 B 时点 A 卡片上旧的取消选中，不影响 B", async () => {
    await h.fromUser(ALICE, "a");
    await h.fromUser(BOB, "b");
    await h.press(OWNER, OWNER, 1, `select:${BOB}`);
    await h.press(OWNER, OWNER, 2, `unselect:${ALICE}`);
    h.tg.reset();
    await h.fromOwner("给 B");
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === BOB)).toBe(true);
  });

  it("选中 A 时 B 来消息，B 的卡片上提醒正在回复 A", async () => {
    await h.fromUser(ALICE, "a");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    h.tg.reset();
    await h.fromUser(BOB, "b");
    expect(h.tg.textsTo(OWNER).join()).toContain("你正在回复 用户2001");
  });

  it("隔离区点屏蔽，留在隔离区这一页", async () => {
    await h.set("blockedKeywords", ["广告"]);
    await h.fromUser(ALICE, "这是广告");
    await h.press(OWNER, OWNER, 1, "filtered:0");
    const page = h.tg.last("editMessageText");
    const data = (page.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find((button) => button.text.includes("屏蔽"))?.callback_data ?? "";
    await h.press(OWNER, OWNER, 1, data);
    expect(String(h.tg.last("editMessageText").text)).toContain("隔离区");
    expect(h.tg.named("editMessageReplyMarkup")).toHaveLength(0);
  });

  it("按钮操作出错时弹窗说明，不是点了没反应", async () => {
    await h.fromUser(ALICE, "a");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    await h.fromOwner("发出去的");
    const id = num((await row("SELECT id FROM messages WHERE direction = 'out'")).id);
    h.tg.failNext("deleteMessage", 403, "Forbidden: bot was blocked by the user");
    await h.press(OWNER, OWNER, 9, `undo!:${id}`);
    expect(String(h.tg.last("answerCallbackQuery").text)).toContain("拉黑");
  });

  it("回应按钮失败不影响验证通过后转发暂存的消息", async () => {
    h = await makeHarness();
    await h.fromUser(ALICE, "验证前的话");
    h.tg.failNext("answerCallbackQuery", 400, "Bad Request: query is too old");
    await h.passVerification(ALICE);
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === OWNER)).toBe(true);
  });

  it("关掉验证后，之前暂存的消息转过去", async () => {
    h = await makeHarness();
    await h.fromUser(ALICE, "验证前的话");
    await h.set("verifyMode", "off");
    h.tg.reset();
    await h.fromUser(ALICE, "后来的话");
    expect(h.tg.named("copyMessage").filter((params) => params.chat_id === OWNER)).toHaveLength(2);
  });

  it("重新点开始时重发验证题", async () => {
    h = await makeHarness();
    await h.fromUser(ALICE, "/start");
    h.tg.reset();
    await h.fromUser(ALICE, "/start");
    expect(h.tg.textsTo(ALICE).join()).toContain("答一道题");
  });

  it("群发遇到网络错误不跳过这个人，下一轮接着发", async () => {
    await h.fromUser(ALICE, "a");
    await h.app.db.prepare("INSERT INTO broadcasts(from_chat_id, from_msg_id, report_chat_id, total, created_at, state) VALUES(?, 1, ?, 1, 1, 'running')").bind(OWNER, OWNER).run();
    h.tg.failNext("copyMessage", 0, "network timeout");
    await broadcastTick(h.app);
    expect(num((await row("SELECT failed FROM broadcasts")).failed)).toBe(0);
    await broadcastTick(h.app);
    expect(num((await row("SELECT sent FROM broadcasts")).sent)).toBe(1);
  });

  it("补发时一条坏消息不堵后面的人，超时放弃会告诉主人", async () => {
    await h.fromUser(ALICE, "a");
    await h.fromUser(BOB, "b");
    await h.app.db.prepare("UPDATE messages SET status = 'failed' WHERE direction = 'in'").run();
    h.tg.reset();
    h.tg.failNext("copyMessage", 403, "Forbidden: bot is not a member of the chat");
    await retryFailed(h.app);
    expect(num((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed' AND user_id = ?", ALICE)).n)).toBe(1);
    expect(num((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent' AND user_id = ?", BOB)).n)).toBe(1);
    h.clock.now += 2 * 86_400;
    h.tg.reset();
    await tick(h.app);
    expect(h.tg.textsTo(OWNER).join()).toContain("已经放弃");
    h.tg.reset();
    await tick(h.app);
    expect(h.tg.textsTo(OWNER).join()).not.toContain("已经放弃");
  });

  it("快捷回复留底失败不说没发出去，也不重复发", async () => {
    await h.fromUser(ALICE, "a");
    await h.fromOwner("/qadd 价格 99 元");
    await h.press(OWNER, OWNER, 1, `qp:${ALICE}`);
    const data = (h.tg.last("sendMessage").reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find((button) => button.text === "价格")?.callback_data ?? "";
    await h.press(OWNER, OWNER, 2, data);
    await h.press(OWNER, OWNER, 2, data);
    expect(h.tg.textsTo(ALICE).filter((text) => text === "99 元")).toHaveLength(1);
  });
});

describe("空档期和通知失败", () => {
  it("没验证过的人空档期留言：绑定后发验证题，答对才转过去", async () => {
    h = await makeHarness({ owner: false });
    await createClaim(h.app, { mode: "user", user: "u2002" });
    await h.fromUser(ALICE, "空档里的话");
    expect(h.tg.textsTo(ALICE).at(-1)).toContain("消息已保存");
    await h.fromUser(BOB, "我是管理员");
    await h.send({});
    expect(h.tg.textsTo(ALICE).at(-1)).toContain("答完这道题");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    await h.passVerification(ALICE);
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === BOB)).toBe(true);
  });

  it("绑定时通知全部失败，暂存的消息也要转过去", async () => {
    h = await makeHarness({ verify: false, owner: false });
    await createClaim(h.app, { mode: "user", user: "u2002" });
    await h.fromUser(ALICE, "空档里的话");
    h.tg.failNext("setMyCommands", 0, "network");
    h.tg.failNext("sendMessage", 0, "network");
    h.tg.failNext("sendMessage", 0, "network");
    await h.fromUser(BOB, "我是管理员");
    await h.send({});
    expect(h.app.settings.ownerId).toBe(BOB);
    expect(num((await row("SELECT COUNT(*) AS n FROM held_messages")).n)).toBe(0);
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === BOB)).toBe(true);
  });

  it("已屏蔽的人暂存的消息不转", async () => {
    h = await makeHarness({ verify: false, owner: false });
    await createClaim(h.app, { mode: "user", user: "u2002" });
    await h.fromUser(ALICE, "空档里的话");
    await h.app.db.prepare("UPDATE contacts SET blocked_at = 1").run();
    await h.fromUser(BOB, "我是管理员");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
  });

  it("换管理员后，新管理员第一次收到消息会带身份卡片", async () => {
    h = await makeHarness({ verify: false });
    await h.fromUser(ALICE, "第一条");
    const code = await createClaim(h.app);
    await h.fromUser(BOB, `/start claim_${code}`);
    h.tg.reset();
    await h.fromUser(ALICE, "换人后");
    expect(h.tg.textsTo(BOB).join()).toContain("用户2001");
  });

  it("放弃补发的通知失败时，下一轮还会说", async () => {
    h = await makeHarness({ verify: false });
    await h.fromUser(ALICE, "a");
    await h.app.db.prepare("UPDATE messages SET status = 'failed' WHERE direction = 'in'").run();
    h.clock.now += 2 * 86_400;
    h.tg.reset();
    h.tg.failNext("sendMessage", 0, "network");
    await tick(h.app);
    expect(num((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed'")).n)).toBe(1);
    await tick(h.app);
    expect(h.tg.textsTo(OWNER).join()).toContain("已经放弃");
    expect(num((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'lost'")).n)).toBe(1);
  });

  it("审核通知失败不影响这条消息，也不重复入库", async () => {
    h = await makeHarness({ verify: false });
    await h.set("reviewNewContacts", true);
    await h.fromUser(ALICE, "第一条");
    await h.app.db.prepare("DELETE FROM messages").run();
    await h.app.db.prepare("UPDATE contacts SET msg_count = 0").run();
    h.tg.failNext("sendMessage", 0, "network");
    await h.fromUser(ALICE, "这一条");
    expect(num((await row("SELECT COUNT(*) AS n FROM messages WHERE status = 'filtered'")).n)).toBe(1);
  });
});

describe("第一次的自动回复", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });

  it("没点开始直接发消息，也算第一次：回一次，消息照常转过去", async () => {
    await h.set("welcome", "你好，有事留言");
    await h.fromUser(ALICE, "直接发的");
    expect(h.tg.textsTo(ALICE)).toEqual(["你好，有事留言"]);
    expect(h.tg.named("copyMessage").some((params) => params.chat_id === OWNER)).toBe(true);
    await h.app.db.prepare("UPDATE contacts SET unread = 0").run();
    await h.fromUser(ALICE, "第二句");
    expect(h.tg.textsTo(ALICE)).toEqual(["你好，有事留言"]);
  });

  it("开着验证时直接发消息：先回自动回复，再出题，答对才转", async () => {
    h = await makeHarness();
    await h.set("welcome", "你好，有事留言");
    await h.fromUser(ALICE, "直接发的");
    const texts = h.tg.textsTo(ALICE);
    expect(texts[0]).toBe("你好，有事留言");
    expect(texts[1]).toContain("答一道题");
    expect(h.tg.named("copyMessage")).toHaveLength(0);
    await h.fromUser(ALICE, "再发一句");
    expect(h.tg.textsTo(ALICE).filter((text) => text === "你好，有事留言")).toHaveLength(1);
  });

  it("只有文字：点开始时回一次，之后的消息不再回文字，只打 👌", async () => {
    await h.set("welcome", "你好，有事留言");
    await h.fromUser(ALICE, "/start");
    expect(h.tg.textsTo(ALICE)).toEqual(["你好，有事留言"]);
    await h.fromUser(ALICE, "第一句");
    await h.app.db.prepare("UPDATE contacts SET unread = 0").run();
    await h.fromUser(ALICE, "第二句");
    expect(h.tg.textsTo(ALICE)).toEqual(["你好，有事留言"]);
    expect(h.tg.named("setMessageReaction").filter((params) => params.chat_id === ALICE)).toHaveLength(2);
  });

  it("在 Telegram 里发带说明的图片：文字和图片一起发", async () => {
    await h.press(OWNER, OWNER, 1, "mi:welcome");
    await h.fromOwner(undefined as never, { photo: [{ file_id: "small", file_unique_id: "s", width: 1, height: 1 }, { file_id: "big", file_unique_id: "b", width: 9, height: 9 }], caption: "看这张图" });
    await h.fromUser(ALICE, "/start");
    expect(h.tg.last("sendPhoto")).toMatchObject({ chat_id: ALICE, photo: "big", caption: "看这张图" });
    expect(h.tg.textsTo(ALICE)).toEqual([]);
  });

  it("网页上传的图片：第一次上传，之后用文件编号", async () => {
    await h.app.db.prepare("INSERT INTO assets(name, mime, data) VALUES('welcome', 'image/png', 'iVBORw0KGgo=')").run();
    await h.set("welcomeImage", true);
    h.tg.responses.set("sendPhoto", { photo: [{ file_id: "fid" }] });
    const upload = h.tg.upload.bind(h.tg);
    h.tg.upload = (async (method: string, params: Record<string, unknown>) => {
      await upload(method, params);
      return { photo: [{ file_id: "fid" }] };
    }) as never;
    await h.fromUser(ALICE, "/start");
    await h.send({});
    expect(h.app.settings.welcomePhotoId).toBe("fid");
    await h.fromUser(BOB, "/start");
    expect(h.tg.last("sendPhoto")).toMatchObject({ chat_id: BOB, photo: "fid" });
  });

  it("图片发不出去时退回文字，不能让人收不到回复", async () => {
    await h.set("welcome", "文字还在");
    await h.set("welcomeImage", true);
    await h.set("welcomePhotoId", "old");
    h.tg.failNext("sendPhoto", 400, "Bad Request: wrong file identifier");
    await h.fromUser(ALICE, "/start");
    expect(h.tg.textsTo(ALICE)).toEqual(["文字还在"]);
    await h.send({});
    expect(h.app.settings.welcomeImage).toBe(false);
  });

  it("文字超过图片说明上限时分两条发", async () => {
    await h.set("welcome", "长".repeat(1500));
    await h.set("welcomeImage", true);
    await h.set("welcomePhotoId", "fid");
    await h.fromUser(ALICE, "/start");
    expect(h.tg.last("sendPhoto").caption).toBeUndefined();
    expect(h.tg.textsTo(ALICE)).toHaveLength(1);
  });

  it("菜单里能去掉图片", async () => {
    await h.set("welcomeImage", true);
    await h.set("welcomePhotoId", "fid");
    await h.press(OWNER, OWNER, 1, "mc:welcomePhoto:off");
    await h.send({});
    expect(h.app.settings.welcomeImage).toBe(false);
    await h.fromUser(ALICE, "/start");
    expect(h.tg.named("sendPhoto")).toHaveLength(0);
  });
});

describe("进程被杀后 Telegram 重发", () => {
  beforeEach(async () => {
    h = await makeHarness({ verify: false });
  });
  const privateMessage = (id: number, from: number, text: string) => ({ message: { message_id: id, date: 1, chat: { id: from, type: "private" }, from: { id: from, is_bot: false, first_name: "x" }, text } }) as never;

  it("同一条更新发两次只处理一次", async () => {
    const update = { update_id: 5555, ...(privateMessage(70, ALICE, "你好") as object) } as never;
    await handleUpdate(h.app, update);
    await handleUpdate(h.app, update);
    expect(h.tg.named("copyMessage")).toHaveLength(1);
  });

  it("处理中途出错的更新也记下，不会一直卡着重试", async () => {
    h.tg.failNext("sendMessage", 500, "Internal");
    const update = { update_id: 5556, ...(privateMessage(71, ALICE, "/start") as object) } as never;
    await handleUpdate(h.app, update);
    h.tg.reset();
    await handleUpdate(h.app, update);
    expect(h.tg.calls).toHaveLength(0);
  });

  it("没来得及记下更新就被杀：重发的客户消息不再转一遍", async () => {
    await h.send(privateMessage(72, ALICE, "你好"));
    h.tg.reset();
    await h.send(privateMessage(72, ALICE, "你好"));
    expect(h.tg.named("copyMessage")).toHaveLength(0);
  });

  it("没来得及记下更新就被杀：重发的管理员回复不再发给客户一遍", async () => {
    await h.fromUser(ALICE, "你好");
    await h.press(OWNER, OWNER, 1, `select:${ALICE}`);
    await h.send(privateMessage(800, OWNER, "回复"));
    h.tg.reset();
    await h.send(privateMessage(800, OWNER, "回复"));
    expect(h.tg.named("copyMessage")).toHaveLength(0);
  });
});

