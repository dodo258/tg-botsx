// 内容拦截的判断，只看消息本身和配置，不碰数据库，方便单测。
import type { Message } from "@grammyjs/types";

export type FilterVerdict = { action: "pass" } | { action: "hold"; reason: string };

export interface FilterRules {
  blockedKeywords: readonly string[];
  blockLinksForNew: boolean;
  blockForwards: boolean;
}

const LINK = /(https?:\/\/|t\.me\/|tg:\/\/|www\.)\S+/i;

function hasLink(message: Message): boolean {
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  if (entities.some((entity) => entity.type === "url" || entity.type === "text_link")) return true;
  return LINK.test(message.text ?? message.caption ?? "");
}

/** 新联系人指来往消息还不到 3 条的人。 */
export function evaluate(message: Message, rules: FilterRules, isNewContact: boolean): FilterVerdict {
  const text = (message.text ?? message.caption ?? "").toLowerCase();
  for (const keyword of rules.blockedKeywords) {
    const needle = keyword.trim().toLowerCase();
    if (needle && text.includes(needle)) return { action: "hold", reason: `命中关键词「${keyword.trim()}」` };
  }
  if (rules.blockForwards && message.forward_origin) return { action: "hold", reason: "转发内容" };
  if (rules.blockLinksForNew && isNewContact && hasLink(message)) return { action: "hold", reason: "新联系人发链接" };
  return { action: "pass" };
}
