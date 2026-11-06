// 从 Telegram 消息里取类型、文本和文件。贴纸、动图、圆视频、位置都算在内，类型名只存英文键，显示用中文。
import type { Message } from "@grammyjs/types";

export interface MessageInfo {
  kind: string;
  text: string;
  fileId: string;
}

export function describe(message: Message): MessageInfo {
  const text = message.text ?? message.caption ?? "";
  const lastPhoto = message.photo?.at(-1);
  if (lastPhoto) return { kind: "photo", text, fileId: lastPhoto.file_id };
  if (message.video) return { kind: "video", text, fileId: message.video.file_id };
  if (message.animation) return { kind: "animation", text, fileId: message.animation.file_id };
  if (message.document) return { kind: "document", text, fileId: message.document.file_id };
  if (message.voice) return { kind: "voice", text, fileId: message.voice.file_id };
  if (message.audio) return { kind: "audio", text, fileId: message.audio.file_id };
  if (message.video_note) return { kind: "video_note", text, fileId: message.video_note.file_id };
  if (message.sticker) return { kind: "sticker", text: message.sticker.emoji ?? "", fileId: message.sticker.file_id };
  if (message.location) return { kind: "location", text, fileId: "" };
  if (message.contact) return { kind: "contact", text: message.contact.phone_number, fileId: "" };
  if (message.poll) return { kind: "poll", text: message.poll.question, fileId: "" };
  if (message.dice) return { kind: "dice", text: String(message.dice.value), fileId: "" };
  if (message.story) return { kind: "story", text, fileId: "" };
  if (message.text !== undefined) return { kind: "text", text, fileId: "" };
  return { kind: "other", text, fileId: "" };
}

const LABELS: Record<string, string> = {
  text: "文字",
  photo: "图片",
  video: "视频",
  animation: "动图",
  document: "文件",
  voice: "语音",
  audio: "音频",
  video_note: "圆视频",
  sticker: "贴纸",
  location: "位置",
  contact: "名片",
  poll: "投票",
  dice: "骰子",
  story: "动态",
  other: "其他消息",
};

export function kindLabel(kind: string): string {
  return LABELS[kind] ?? "其他消息";
}

/** 服务消息（入群、话题创建、置顶等）不是人发的内容，不转发。 */
export function isServiceMessage(message: Message): boolean {
  return (
    Object.hasOwn(message, "forum_topic_created") ||
    Object.hasOwn(message, "forum_topic_closed") ||
    Object.hasOwn(message, "forum_topic_reopened") ||
    Object.hasOwn(message, "forum_topic_edited") ||
    Object.hasOwn(message, "general_forum_topic_hidden") ||
    Object.hasOwn(message, "general_forum_topic_unhidden") ||
    Object.hasOwn(message, "new_chat_members") ||
    Object.hasOwn(message, "left_chat_member") ||
    Object.hasOwn(message, "new_chat_title") ||
    Object.hasOwn(message, "new_chat_photo") ||
    Object.hasOwn(message, "delete_chat_photo") ||
    Object.hasOwn(message, "group_chat_created") ||
    Object.hasOwn(message, "supergroup_chat_created") ||
    Object.hasOwn(message, "channel_chat_created") ||
    Object.hasOwn(message, "pinned_message") ||
    Object.hasOwn(message, "migrate_to_chat_id") ||
    Object.hasOwn(message, "migrate_from_chat_id") ||
    Object.hasOwn(message, "message_auto_delete_timer_changed") ||
    Object.hasOwn(message, "video_chat_started") ||
    Object.hasOwn(message, "video_chat_ended")
  );
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

/** 转义后不超过 max 个字符。必须先截后转义，转义后再截会切断实体或标签，Telegram 会拒收整条消息。 */
/** 按字符截断。slice 按 UTF-16 切，可能把表情切成半个，Telegram 收到会出错 */
export function clipChars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

export function clipHtml(value: string, max: number): string {
  let used = 0;
  let out = "";
  for (const char of value) {
    const piece = escapeHtml(char);
    if (used + piece.length > max) return `${out}…`;
    out += piece;
    used += piece.length;
  }
  return out;
}

/** Telegram 单条消息上限 4096 字符，留点余量。放不下的行整行丢弃，不切开，保证 HTML 完整。 */
export function fitLines(lines: readonly string[], separator: string, max = 3800): { text: string; kept: string[] } {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + separator.length > max) break;
    kept.push(line);
    length += line.length + separator.length;
  }
  return { text: kept.join(separator), kept };
}
