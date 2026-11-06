// 一台服务器上的多个机器人。每个机器人一个目录、一个 Token 文件、一个数据库文件，
// 代码里没有跨机器人的查询，数据靠文件隔开。默认机器人的 Token 在环境变量，数据库在数据目录根下。
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cryptoRng as appRng } from "../core/verify.ts";
import { migrate } from "../core/schema.ts";
import { loadSettings } from "../core/settings.ts";
import type { Settings } from "../core/settings.ts";
import { claimLink, createClaim, fetchBot } from "../core/setup.ts";
import type { ClaimOptions } from "../core/setup.ts";
import { createTelegram, TelegramError } from "../core/telegram.ts";
import type { App } from "../core/app.ts";
import { num } from "../core/db.ts";
import { sqliteDb } from "./sqlite-adapter.ts";

export const DEFAULT_NAME = "默认";
const RESERVED = new Set(["add", "list", "update-all", "status", "logs", "restart", "update", "backup", "restore", "claim", "token", "uninstall", "web"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN = /^\d{3,}:[\w-]{10,}$/;

export interface FleetEnv {
  dataDir: string;
  apiBase?: string | undefined;
  defaultToken?: string | undefined;
}

export const botsDir = (env: FleetEnv) => join(env.dataDir, "bots");
const isDefault = (name: string) => name === DEFAULT_NAME;
export const dbPath = (env: FleetEnv, name: string) => (isDefault(name) ? join(env.dataDir, "relay.db") : join(botsDir(env), name, "relay.db"));
const tokenPath = (env: FleetEnv, name: string) => join(botsDir(env), name, "token");

export function extraNames(env: FleetEnv): string[] {
  if (!existsSync(botsDir(env))) return [];
  return readdirSync(botsDir(env)).filter((name) => NAME.test(name) && existsSync(tokenPath(env, name))).sort();
}

export function allNames(env: FleetEnv): string[] {
  return [...(env.defaultToken ? [DEFAULT_NAME] : []), ...extraNames(env)];
}

export function readToken(env: FleetEnv, name: string): string {
  if (isDefault(name)) return env.defaultToken ?? "";
  return readFileSync(tokenPath(env, name), "utf8").trim();
}

function nameInUse(env: FleetEnv, token: string): string | null {
  return allNames(env).find((name) => readToken(env, name) === token) ?? null;
}

/** 校验是给人看的：错误信息直接显示在命令行和网页上，不带 Token。 */
async function checkToken(env: FleetEnv, token: string): Promise<{ username: string }> {
  if (!TOKEN.test(token)) throw new Error("这不像机器人 Token，正确的样子是 123456:ABC-DEF…，到 @BotFather 复制完整的一串。");
  const owner = nameInUse(env, token);
  if (owner) throw new Error(`这个 Token 已经给「${owner}」用了。同一个 Token 跑两份，两边都收不到消息。`);
  const tg = createTelegram({ token, apiBase: env.apiBase });
  try {
    const me = await tg.call<{ username?: string }>("getMe");
    return { username: me.username ?? "" };
  } catch (error) {
    if (error instanceof TelegramError && error.code === 401) throw new Error("Telegram 不认这个 Token，到 @BotFather 发 /token 核对。");
    throw new Error(`连不上 Telegram：${error instanceof Error ? error.message : String(error)}`);
  }
}

function withApp<T>(env: FleetEnv, name: string, token: string, work: (app: App) => Promise<T>): Promise<T> {
  const db = sqliteDb(dbPath(env, name));
  const run = async () => {
    await migrate(db);
    const app: App = {
      db,
      tg: createTelegram({ token, apiBase: env.apiBase }),
      settings: await loadSettings(db),
      rng: appRng,
      now: () => Math.floor(Date.now() / 1000),
      nowMs: () => Date.now(),
      defer: () => undefined,
      log: () => undefined,
    };
    return await work(app);
  };
  return run().finally(() => db.close());
}

export interface AddOptions {
  name?: string | undefined;
  /** 只让这个 Telegram 用户名绑定；不填就谁先点算谁 */
  claimUser?: string | undefined;
}

export function normalizeUsername(value: string | undefined): string {
  return (value ?? "").trim().replace(/^@/, "").toLowerCase();
}

export async function addBot(env: FleetEnv, tokenInput: string, options: AddOptions = {}): Promise<BotInfo> {
  const token = tokenInput.trim();
  const { username } = await checkToken(env, token);
  const claimUser = normalizeUsername(options.claimUser);
  if (claimUser && !/^[a-z0-9_]{3,32}$/.test(claimUser)) throw new Error("用户名只能有英文字母、数字和下划线，比如 @zhangsan。");
  const name = options.name ?? (username.toLowerCase().replace(/_/g, "-") || `bot${token.split(":")[0]}`);
  if (!NAME.test(name)) throw new Error("名字只能用小写英文字母、数字和连字符，最长 40 个字符，比如 shop 或 team-2。");
  if (RESERVED.has(name)) throw new Error(`${name} 是 tgbot 自己的命令，换一个名字。`);
  if (existsSync(tokenPath(env, name))) throw new Error(`已经有叫 ${name} 的机器人了。`);
  const dir = join(botsDir(env), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const claim: ClaimOptions = claimUser ? { mode: "user", user: claimUser } : { mode: "open" };
  await withApp(env, name, token, async (app) => {
    await fetchBot(app);
    await createClaim(app, claim);
  });
  // Token 文件最后写：运行中的进程看到它才会启动机器人，这时数据库已经准备好了
  const temp = `${tokenPath(env, name)}.tmp`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  renameSync(temp, tokenPath(env, name));
  return await describeBot(env, name);
}

export function setToken(env: FleetEnv, name: string, token: string): void {
  writeFileSync(tokenPath(env, name), `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(tokenPath(env, name), 0o600);
}

export async function replaceToken(env: FleetEnv, name: string, tokenInput: string): Promise<void> {
  const token = tokenInput.trim();
  await checkToken(env, token);
  setToken(env, name, token);
}

export function removeBot(env: FleetEnv, name: string): void {
  if (isDefault(name)) throw new Error("默认机器人不能在这里删，在服务器上运行 tgbot uninstall。");
  if (!NAME.test(name) || !existsSync(tokenPath(env, name))) throw new Error(`没有叫 ${name} 的机器人。`);
  rmSync(join(botsDir(env), name), { recursive: true, force: true });
}

export interface BotInfo {
  name: string;
  username: string;
  bound: boolean;
  ownerName: string;
  ownerUsername: string;
  ownerId: number | null;
  claimOpen: boolean;
  claimMode: Settings["claimMode"];
  claimUser: string;
  claimPair: string;
  claimExpiresAt: number;
  link: string;
  contacts: number;
  inbound: number;
  /** 数据库打不开时的原因。这时其他字段都是空的 */
  broken?: string;
}

/** 列表用：一个机器人的数据库坏了，它这一行显示故障，不能让整个列表出不来。 */
export async function describeSafely(env: FleetEnv, name: string): Promise<BotInfo> {
  try {
    return await describeBot(env, name);
  } catch (error) {
    return { name, username: "", bound: false, ownerName: "", ownerUsername: "", ownerId: null, claimOpen: false, claimMode: "open", claimUser: "", claimPair: "", claimExpiresAt: 0, link: "", contacts: 0, inbound: 0, broken: error instanceof Error ? error.message : String(error) };
  }
}

export async function describeBot(env: FleetEnv, name: string): Promise<BotInfo> {
  const db = sqliteDb(dbPath(env, name));
  try {
    await migrate(db);
    const settings = await loadSettings(db);
    const counts = await db.prepare("SELECT (SELECT COUNT(*) FROM contacts) AS contacts, (SELECT COUNT(*) FROM messages WHERE direction = 'in') AS inbound").first<{ contacts: unknown; inbound: unknown }>();
    const bound = settings.ownerId !== null;
    const claimOpen = !bound && settings.claimExpiresAt > Math.floor(Date.now() / 1000);
    return {
      name,
      username: settings.botUsername,
      bound,
      ownerName: settings.ownerName,
      ownerUsername: settings.ownerUsername,
      ownerId: settings.ownerId,
      claimOpen,
      claimMode: settings.claimMode,
      claimUser: settings.claimUser,
      claimPair: settings.claimPair,
      claimExpiresAt: settings.claimExpiresAt,
      link: settings.claimCode && settings.botUsername ? claimLink(settings.botUsername, settings.claimCode) : "",
      contacts: num(counts?.contacts),
      inbound: num(counts?.inbound),
    };
  } finally {
    db.close();
  }
}

/**
 * 重新指定管理员。填了用户名，那个人私聊就绑定。留空时，新机器人谁先点算谁；
 * 已经有联系人的机器人不能这样：老客户点一下就能读到别人的聊天记录，所以只给一个一次性链接。
 * 聊天数据不动，旧管理员的话题群和选中状态要清掉，否则他的群还能继续收发。
 */
export async function assignOwner(env: FleetEnv, name: string, userInput: string | undefined): Promise<BotInfo> {
  const claimUser = normalizeUsername(userInput);
  if (claimUser && !/^[a-z0-9_]{3,32}$/.test(claimUser)) throw new Error("用户名只能有英文字母、数字和下划线，比如 @zhangsan。");
  const db = sqliteDb(dbPath(env, name));
  try {
    await migrate(db);
    await db.prepare("DELETE FROM settings WHERE key IN ('ownerId', 'ownerName', 'ownerUsername', 'deskMode', 'groupId', 'lastCardUser')").run();
    await db.prepare("UPDATE contacts SET thread_id = NULL, thread_claim_at = NULL").run();
    await db.prepare("DELETE FROM staff_state").run();
  } finally {
    db.close();
  }
  const before = await describeBot(env, name);
  const options: ClaimOptions = claimUser ? { mode: "user", user: claimUser } : before.contacts > 0 ? { mode: "link" } : { mode: "open" };
  await withApp(env, name, readToken(env, name), async (app) => {
    await createClaim(app, options);
  });
  return await describeBot(env, name);
}
