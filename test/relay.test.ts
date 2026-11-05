import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALICE, BOB, GROUP, makeHarness, OWNER } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { num } from "../src/core/db.ts";
import type { SqlValue } from "../src/core/db.ts";

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
    for (let i = 0; i < 20; i++) await h.fromUser(ALICE, `m${i}`);
    expect((await row("SELECT COUNT(*) AS n FROM held_messages")).n).toBe(5);
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
    expect(h.tg.named("copyMessage")).toHaveLength(1);
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

  it("收到回执：只在一波消息的第一条发，冷却期内不重复", async () => {
    await h.fromUser(ALICE, "1");
    await h.fromUser(ALICE, "2");
    await h.app.db.prepare("UPDATE contacts SET unread = 0 WHERE user_id = ?").bind(ALICE).run();
    await h.fromUser(ALICE, "3");
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
    h.clock.now += 601;
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

  it("Webhook 被改掉时自检会改回来", async () => {
    const { checkWebhook } = await import("../src/core/maintenance.ts");
    await h.set("webhookUrl", "https://x.workers.dev/telegram/webhook");
    h.tg.responses.set("getWebhookInfo", { url: "" });
    await checkWebhook(h.app, "123:abc");
    expect(h.tg.last("setWebhook").url).toBe("https://x.workers.dev/telegram/webhook");
    expect(h.tg.last("setWebhook").secret_token).toBeTruthy();
    expect(h.tg.last("setWebhook").max_connections).toBe(1);
  });

  it("一条坏更新不会抛出，后面的更新继续处理", async () => {
    h.tg.failNext("sendMessage", 500, "Internal");
    h.tg.failNext("copyMessage", 500, "Internal");
    await h.fromUser(ALICE, "hi");
    await h.fromUser(ALICE, "hi2");
    expect(h.tg.named("copyMessage").length).toBeGreaterThan(0);
  });
});

describe("免费额度", () => {
  // Cloudflare 免费版每次调用最多 50 个子请求，D1 查询和 Telegram 调用都算。这里把两者都数上。
  async function countFor(run: () => Promise<unknown>): Promise<number> {
    const { db, tg } = h.app;
    let count = 0;
    const originalPrepare = db.prepare.bind(db);
    const originalBatch = db.batch.bind(db);
    const originalCall = tg.call.bind(tg);
    db.prepare = (sql) => {
      const wrap = (statement: ReturnType<typeof originalPrepare>): ReturnType<typeof originalPrepare> => ({
        bind: (...values: SqlValue[]) => wrap(statement.bind(...values)),
        first: () => (count++, statement.first()),
        all: () => (count++, statement.all()),
        run: () => (count++, statement.run()),
        raw: statement,
      } as never);
      return wrap(originalPrepare(sql));
    };
    db.batch = (statements) => {
      count++;
      return originalBatch(statements.map((statement) => (statement as unknown as { raw: never }).raw));
    };
    tg.call = (method, params) => (count++, originalCall(method, params)) as never;
    await run();
    db.prepare = originalPrepare;
    db.batch = originalBatch;
    tg.call = originalCall;
    return count;
  }

  it("普通消息、首次建话题的消息都远低于 50 次", async () => {
    h = await makeHarness({ verify: false });
    const first = await countFor(() => h.fromUser(ALICE, "第一条"));
    const next = await countFor(() => h.fromUser(ALICE, "第二条"));
    expect(first).toBeLessThanOrEqual(20);
    expect(next).toBeLessThanOrEqual(12);
    await h.set("deskMode", "group");
    await h.set("groupId", GROUP);
    const topic = await countFor(() => h.fromUser(BOB, "第一条"));
    expect(topic).toBeLessThanOrEqual(20);
  });

  it("群发一批不超过 50 次", async () => {
    h = await makeHarness({ verify: false });
    for (let id = 3000; id < 3100; id++) await h.app.db.prepare("INSERT INTO contacts(user_id, first_seen, last_seen, msg_count) VALUES(?, 1, 1, 1)").bind(id).run();
    await h.app.db.prepare("INSERT INTO broadcasts(from_chat_id, from_msg_id, report_chat_id, state, created_at) VALUES(1000, 1, 1000, 'running', 1)").run();
    const { broadcastTick } = await import("../src/core/maintenance.ts");
    const count = await countFor(() => broadcastTick(h.app));
    expect(count).toBeLessThanOrEqual(50);
    expect(h.tg.named("copyMessage")).toHaveLength(25);
  });
});
