// 把 Telegram 更新分发到对应流水线。这里的约定：任何异常都不往外抛，一条坏更新不能影响后面的消息。
import type { ChatMemberUpdated, Message, Update } from "@grammyjs/types";
import type { App } from "./app.ts";
import { isOwner } from "./app.ts";
import { handleCallback } from "./callbacks.ts";
import { cmdBindGroup, handleCommand, isOtherBotCommand, parseCommand } from "./commands.ts";
import { noticeToOwner } from "./desk.ts";
import { handleContactMessage } from "./inbound.ts";
import { isServiceMessage } from "./message-info.ts";
import { currentAwaiting } from "./menus.ts";
import { handleStaffMessage } from "./outbound.ts";
import { rememberUi, trackedApp } from "./ui-clean.ts";
import { handleInput } from "./panel.ts";
import { saveSetting } from "./settings.ts";
import { claimIfDesignated, firstClaimOpen, sendClaimPrompt, tryClaim } from "./setup.ts";
import { handleContactEdit, handleReaction, handleStaffEdit } from "./sync.ts";

function staffIdOf(message: Message): number | null {
  if (message.is_automatic_forward) return null;
  // 匿名管理员的 from 是系统机器人，sender_chat 才是群本身
  if (message.sender_chat?.id === message.chat.id) return message.chat.id;
  if (message.from && !message.from.is_bot) return message.from.id;
  return null;
}

async function staffPipeline(app: App, message: Message, staffId: number): Promise<void> {
  const command = parseCommand(message.text, app.settings.botUsername);
  // 双斜杠是内部备注，不算命令
  const isSlash = message.text?.startsWith("/") === true && !message.text.startsWith("//");
  // 主人私聊里操作机器人的消息要自动清理。群发的内容不算：之后还要从这条复制
  const ui = trackedApp(app, message.chat.id);
  const owned = ui !== app;
  const keepSource = (await currentAwaiting(app, staffId, message)) === "p:broadcast";
  if (await handleInput(ui, message, staffId)) {
    if (owned && !keepSource) await rememberUi(app, message.chat.id, message.message_id);
    return;
  }
  if (command) {
    if (owned) await rememberUi(app, message.chat.id, message.message_id);
    const known = await handleCommand(ui, message, staffId, command.name, command.args);
    if (!known) {
      await ui.tg.call("sendMessage", {
        chat_id: message.chat.id,
        ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
        text: "没有这个命令，发 /help 看看。这条没有发给对方。",
      });
    }
    return;
  }
  if (isSlash) {
    if (isOtherBotCommand(message.text, app.settings.botUsername)) return;
    // /etc/hosts、/你好 这种不是命令。为防打错命令发给客户，不转发，但要说清楚
    await app.tg.call("sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      text: "以 / 开头的内容不会转发，这条没发出去。确实要发的话，在前面加一个字。",
    });
    return;
  }
  await handleStaffMessage(app, message, staffId);
}

async function routeMessage(app: App, message: Message): Promise<void> {
  if (isServiceMessage(message)) return;
  const chat = message.chat;
  if (chat.type === "channel") return;

  if (chat.type === "private") {
    const user = message.from;
    if (!user || user.is_bot) return;
    if (await tryClaim(app, message)) return;
    if (await claimIfDesignated(app, user, chat.id)) return;
    if (firstClaimOpen(app, user)) {
      await sendClaimPrompt(app, chat.id);
      return;
    }
    if (!isOwner(app, user.id)) {
      await handleContactMessage(app, message, user);
      return;
    }
    const isCommand = parseCommand(message.text, app.settings.botUsername) !== null;
    if (app.settings.deskMode === "group" && !isCommand && !(await handleInput(app, message, user.id))) {
      await app.tg.call("sendMessage", { chat_id: chat.id, text: "现在是话题群模式，请到群里对应的话题回复。这条没有发给任何人。" });
      return;
    }
    if (app.settings.deskMode === "group" && !isCommand) return;
    await staffPipeline(app, message, user.id);
    return;
  }

  // 群组：只理绑定的话题群，其他群只响应绑定命令，别的一律不碰。
  if (app.settings.deskMode === "group" && chat.id === app.settings.groupId) {
    const staffId = staffIdOf(message);
    if (staffId === null) return;
    await staffPipeline(app, message, staffId);
    return;
  }
  // 点「绑定话题群」按钮把机器人拉进群后，Telegram 会在群里发 /start bind
  const command = parseCommand(message.text, app.settings.botUsername);
  if (command?.name === "bindgroup" || (command?.name === "start" && command.args === "bind")) await cmdBindGroup(app, message);
}

async function routeEdited(app: App, message: Message): Promise<void> {
  const chat = message.chat;
  if (chat.type === "private") {
    if (!message.from) return;
    if (isOwner(app, message.from.id)) await handleStaffEdit(app, message);
    else await handleContactEdit(app, message, message.from.id);
    return;
  }
  if (app.settings.deskMode === "group" && chat.id === app.settings.groupId) await handleStaffEdit(app, message);
}

/** 用户拉黑或解除拉黑机器人、机器人被踢出话题群时触发。 */
async function routeMembership(app: App, update: ChatMemberUpdated): Promise<void> {
  const status = update.new_chat_member.status;
  if (update.chat.type === "private") {
    const gone = status === "kicked" || status === "left";
    await app.db.prepare("UPDATE contacts SET unreachable_at = ? WHERE user_id = ?").bind(gone ? app.now() : null, update.chat.id).run();
    return;
  }
  if (update.chat.id !== app.settings.groupId || app.settings.deskMode !== "group") return;
  if (status === "kicked" || status === "left") {
    await saveSetting(app.db, app.settings, "deskMode", "dm");
    await saveSetting(app.db, app.settings, "groupId", null);
    await app.db.prepare("UPDATE contacts SET thread_id = NULL, thread_claim_at = NULL").run();
    await noticeToOwner(app, "机器人被移出了话题群，已自动切回私聊模式，消息不会丢。");
  } else if (status !== "administrator") {
    await noticeToOwner(app, "机器人在话题群里不再是管理员，新联系人的话题会建不出来。请恢复它的管理员权限。");
  }
}

export async function handleUpdate(app: App, update: Update): Promise<void> {
  try {
    // 去重：进程重启后 Telegram 会重发还没确认的更新。处理完才记下来：
    // 先记的话，处理途中被杀，重发时会被当成处理过，这条消息就永远丢了。
    // 这样处理途中被杀会再处理一次，所以消息本身还要按编号再去重一次（见 inbound 和 outbound）
    const seen = await app.db.prepare("SELECT update_id FROM seen_updates WHERE update_id = ?").bind(update.update_id).first();
    if (seen) return;
    if (update.message) await routeMessage(app, update.message);
    else if (update.edited_message) await routeEdited(app, update.edited_message);
    else if (update.callback_query) await handleCallback(app, update.callback_query);
    else if (update.message_reaction) await handleReaction(app, update.message_reaction);
    else if (update.my_chat_member) await routeMembership(app, update.my_chat_member);
  } catch (error) {
    app.log("error", `处理更新 ${update.update_id} 失败`, error instanceof Error ? error.message : String(error));
  }
  // 出错的也记下：同一条坏更新重发多少次都是错，不能卡住后面的消息
  try {
    await app.db.prepare("INSERT OR IGNORE INTO seen_updates(update_id, seen_at) VALUES(?, ?)").bind(update.update_id, app.now()).run();
  } catch (error) {
    app.log("error", `记录更新 ${update.update_id} 失败`, error instanceof Error ? error.message : String(error));
  }
}

export function isUpdate(value: unknown): value is Update {
  return typeof value === "object" && value !== null && "update_id" in value && typeof value.update_id === "number";
}
