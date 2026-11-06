// 网页管理：加机器人、看谁在用、重新指定管理员。不碰聊天内容。
// 所有写操作都要登录；Cookie 只走 HTTPS、不给脚本读、不跨站发送；再校验一次 Origin。
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { freemem as osFree, totalmem } from "node:os";
import { join } from "node:path";
import { saveSetting, loadSettings } from "../core/settings.ts";
import { addBot, allNames, dbPath, DEFAULT_NAME, describeBot, removeBot, reopenClaim, replaceToken, resetOwner } from "./fleet.ts";
import type { BotInfo, FleetEnv } from "./fleet.ts";
import { sqliteDb } from "./sqlite-adapter.ts";
import { loadOrCreateCert } from "./tls.ts";
import { PAGE } from "./web-page.ts";

const SESSION_TTL_SECONDS = 7 * 86_400;
const MAX_BODY = 64 * 1024;
const COOKIE = "tgbotsx_session";

interface Auth {
  user: string;
  salt: string;
  hash: string;
}

const authFile = (env: FleetEnv) => join(env.dataDir, "web", "auth.json");

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

export function setAuth(env: FleetEnv, user: string, password: string): void {
  if (!user.trim()) throw new Error("账号不能是空的。");
  if (password.length < 8) throw new Error("密码至少 8 位。");
  const salt = randomBytes(16).toString("hex");
  const auth: Auth = { user: user.trim(), salt, hash: hashPassword(password, salt) };
  mkdirSync(join(env.dataDir, "web"), { recursive: true, mode: 0o700 });
  const temp = `${authFile(env)}.tmp`;
  writeFileSync(temp, JSON.stringify(auth), { mode: 0o600 });
  renameSync(temp, authFile(env));
}

function readAuth(env: FleetEnv): Auth | null {
  if (!existsSync(authFile(env))) return null;
  const parsed: unknown = JSON.parse(readFileSync(authFile(env), "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const { user, salt, hash } = parsed as Record<string, unknown>;
  return typeof user === "string" && typeof salt === "string" && typeof hash === "string" ? { user, salt, hash } : null;
}

function verify(auth: Auth, user: string, password: string): boolean {
  const expected = Buffer.from(auth.hash, "hex");
  const actual = Buffer.from(hashPassword(password, auth.salt), "hex");
  // 账号不对也算一遍哈希，不让人从响应时间猜账号
  return timingSafeEqual(expected, actual) && user === auth.user;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "内容太长了。");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // 落到下面统一报错
  }
  throw new HttpError(400, "请求格式不对。");
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

export interface WebOptions {
  env: FleetEnv;
  port: number;
  /** 机器人当前的运行状态 */
  stateOf(name: string): "connecting" | "online" | "failed" | "stopped";
}

export function startWeb(options: WebOptions): Server {
  const { env } = options;
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();
  const now = () => Math.floor(Date.now() / 1000);

  // 只在明确配置时才信代理传来的 IP：直连端口的人可以随便伪造这个请求头
  const ipHeader = process.env.WEB_IP_HEADER?.toLowerCase();
  const clientIp = (req: IncomingMessage) => (ipHeader ? text(req.headers[ipHeader]).split(",")[0]?.trim() : "") || req.socket.remoteAddress || "";
  // 总量限制：伪造 IP 也绕不过。比单个 IP 宽，正常情况碰不到
  let globalFailures = { count: 0, windowEnds: 0 };

  const sessionOf = (req: IncomingMessage): string | null => {
    const match = new RegExp(`(?:^|; )${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie ?? "");
    const id = match?.[1];
    if (!id) return null;
    const expires = sessions.get(id);
    if (expires === undefined || expires < now()) {
      sessions.delete(id);
      return null;
    }
    return id;
  };

  const botView = (info: BotInfo) => ({ ...info, link: undefined, state: options.stateOf(info.name), canDelete: info.name !== DEFAULT_NAME, chatLink: info.username ? `https://t.me/${info.username}` : "" });

  const requireBot = (name: string) => {
    if (!allNames(env).includes(name)) throw new HttpError(404, "没有这个机器人。");
    return name;
  };

  const readBotSettings = async (name: string) => {
    const db = sqliteDb(dbPath(env, name));
    try {
      const s = await loadSettings(db);
      return { welcome: s.welcome, verify: s.verifyMode === "quiz" };
    } finally {
      db.close();
    }
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<unknown> {
    const method = req.method ?? "GET";
    if (path === "/api/login" && method === "POST") {
      const ip = clientIp(req);
      const record = failures.get(ip);
      if (record && record.until > now()) throw new HttpError(429, "试错太多次了，15 分钟后再试。");
      if (globalFailures.windowEnds > now() && globalFailures.count >= 50) throw new HttpError(429, "最近登录失败太多，15 分钟后再试。");
      const body = await readJson(req);
      const auth = readAuth(env);
      if (!auth) throw new HttpError(503, "还没有设置账号，在服务器上运行 tgbot web-password。");
      if (!verify(auth, text(body.user), text(body.password))) {
        const count = (record?.count ?? 0) + 1;
        failures.set(ip, { count, until: count >= 5 ? now() + 900 : 0 });
        if (globalFailures.windowEnds <= now()) globalFailures = { count: 0, windowEnds: now() + 900 };
        globalFailures.count++;
        throw new HttpError(401, "账号或密码不对。");
      }
      failures.delete(ip);
      const id = randomBytes(32).toString("hex");
      sessions.set(id, now() + SESSION_TTL_SECONDS);
      res.setHeader("set-cookie", `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`);
      return { ok: true };
    }
    const session = sessionOf(req);
    if (!session) throw new HttpError(401, "请先登录。");
    if (path === "/api/logout" && method === "POST") {
      sessions.delete(session);
      res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return { ok: true };
    }
    if (path === "/api/password" && method === "POST") {
      const body = await readJson(req);
      const auth = readAuth(env);
      if (!auth || !verify(auth, auth.user, text(body.current))) throw new HttpError(400, "当前密码不对。");
      setAuth(env, text(body.user) || auth.user, text(body.password));
      // 其他设备的登录作废，只留当前这个
      for (const id of sessions.keys()) if (id !== session) sessions.delete(id);
      return { ok: true };
    }
    if (path === "/api/bots" && method === "GET") {
      const names = allNames(env);
      const bots = await Promise.all(names.map(async (name) => botView(await describeBot(env, name))));
      return { bots, server: { rss: process.memoryUsage().rss, total: totalmem(), free: osFree(), uptime: Math.floor(process.uptime()) } };
    }
    if (path === "/api/bots" && method === "POST") {
      const body = await readJson(req);
      const tokens = text(body.tokens).split(/[\s,]+/).filter(Boolean);
      if (tokens.length === 0) throw new HttpError(400, "先粘贴 Token。");
      if (tokens.length > 50) throw new HttpError(400, "一次最多加 50 个。");
      const results = [];
      for (const token of tokens) {
        try {
          const info = await addBot(env, token, { claimUser: tokens.length === 1 ? text(body.user) : undefined });
          results.push({ ok: true, name: info.name, username: info.username });
        } catch (error) {
          results.push({ ok: false, error: error instanceof Error ? error.message : String(error), hint: `${token.split(":")[0]}:…` });
        }
      }
      return { results };
    }
    const match = /^\/api\/bots\/([^/]+)(?:\/(assign|token|settings))?$/.exec(path);
    if (!match) throw new HttpError(404, "没有这个接口。");
    const name = requireBot(decodeURIComponent(match[1] ?? ""));
    const action = match[2];
    if (!action && method === "DELETE") {
      removeBot(env, name);
      return { ok: true };
    }
    if (action === "assign" && method === "POST") {
      const body = await readJson(req);
      const info = await describeBot(env, name);
      // 用户名校验失败时不能先把现有管理员清掉，所以校验放在 fleet 里的共用入口之前
      const user = text(body.user).trim().replace(/^@/, "");
      if (user && !/^[A-Za-z0-9_]{3,32}$/.test(user)) throw new HttpError(400, "用户名只能有英文字母、数字和下划线，比如 @zhangsan。");
      const updated = info.bound ? await resetOwner(env, name, { claimUser: user }) : await reopenClaim(env, name, { claimUser: user });
      return botView(updated);
    }
    if (action === "token" && method === "POST") {
      const body = await readJson(req);
      if (name === DEFAULT_NAME) throw new HttpError(400, "默认机器人的 Token 在服务器上用 tgbot token 更换。");
      await replaceToken(env, name, text(body.token));
      return { ok: true };
    }
    if (action === "settings") {
      if (method === "GET") return await readBotSettings(name);
      if (method === "POST") {
        const body = await readJson(req);
        const db = sqliteDb(dbPath(env, name));
        try {
          const settings = await loadSettings(db);
          if (typeof body.welcome === "string") {
            if (!body.welcome.trim() || body.welcome.length > 2000) throw new HttpError(400, "欢迎语不能是空的，也不能超过 2000 字。");
            await saveSetting(db, settings, "welcome", body.welcome);
          }
          if (typeof body.verify === "boolean") await saveSetting(db, settings, "verifyMode", body.verify ? "quiz" : "off");
        } finally {
          db.close();
        }
        return await readBotSettings(name);
      }
    }
    throw new HttpError(404, "没有这个接口。");
  }

  const { key, cert } = loadOrCreateCert(join(env.dataDir, "web"));
  const server = createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url ?? "/", "https://local");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("strict-transport-security", "max-age=31536000");
    if (url.pathname === "/" && req.method === "GET") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      res.end(PAGE);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    // 写操作校验来源，挡跨站请求。Cookie 已经 SameSite=Strict，这是第二道
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin !== undefined && new URL(origin).host !== req.headers.host) {
      res.writeHead(403).end(JSON.stringify({ error: "来源不对。" }));
      return;
    }
    api(req, res, url.pathname)
      .then((result) => res.end(JSON.stringify(result)))
      .catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 400;
        // 这里的错误信息都是写给人看的中文，没有 Token（fleet 和 telegram 都不放 URL）
        res.statusCode = status;
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "出错了。" }));
      });
  });
  server.listen(options.port, () => console.log(`网页管理已启动，端口 ${options.port}`));
  server.on("error", (error) => console.error("网页管理启动失败：", error.message));
  return server;
}
