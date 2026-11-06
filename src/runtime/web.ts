// 网页管理：加机器人、看谁在用、重新指定管理员。不碰聊天内容。
// 所有写操作都要登录；Cookie 只走 HTTPS、不给脚本读、不跨站发送；再校验一次 Origin。
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { freemem as osFree, totalmem } from "node:os";
import { join } from "node:path";
import { activateSchedule, CAPTION_LIMIT, countRecipients, createDraft, deleteSchedule, describeRepeat, getSchedule, listSchedules, parseOnce, parseTimes, scheduleState, TEXT_LIMIT, toggleSchedule } from "../core/schedule.ts";
import type { Schedule } from "../core/schedule.ts";
import { saveSetting, loadSettings } from "../core/settings.ts";
import { addBot, allNames, assignOwner, dbPath, DEFAULT_NAME, describeSafely, removeBot, replaceToken } from "./fleet.ts";
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

// 一次只算一个：scrypt 很吃 CPU，一起算会把同进程的机器人都卡住
let hashQueue: Promise<unknown> = Promise.resolve();

function verify(auth: Auth, user: string, password: string): Promise<boolean> {
  const job = hashQueue.then(
    () =>
      new Promise<boolean>((resolve, reject) => {
        scrypt(password, auth.salt, 32, (error, actual) => {
          if (error) return reject(error);
          // 账号不对也算一遍哈希，不让人从响应时间猜账号
          resolve(timingSafeEqual(Buffer.from(auth.hash, "hex"), actual) && user === auth.user);
        });
      }),
  );
  hashQueue = job.catch(() => undefined);
  return job;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// 上传图片是 base64，比原文件大三分之一
const MAX_UPLOAD_BODY = 8 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGE_MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

function parseImage(image: string): { mime: string; bytes: Buffer } | null {
  if (!image) return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!match) throw new HttpError(400, "图片只支持 JPG、PNG、WebP。");
  const bytes = Buffer.from(match[2] ?? "", "base64");
  if (bytes.length > MAX_IMAGE) throw new HttpError(400, "图片太大了，请控制在 5 MB 以内。");
  const mime = match[1] ?? "";
  if (!IMAGE_MAGIC[mime]?.(bytes)) throw new HttpError(400, "这个文件不是有效的图片。");
  return { mime, bytes };
}

async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, "内容太大了，图片请控制在 5 MB 以内。");
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
  // 总量限制：伪造 IP 也绕不过。超过后不是一律拒绝，而是放慢：攻击者猜不动，主人多试几次还能进
  let globalFailures = { count: 0, windowEnds: 0, lastTry: 0 };

  // 密码在别的进程里改过（tgbot web-password）：旧登录全部作废，锁定也解开
  let authHash = readAuth(env)?.hash ?? "";
  const syncAuth = () => {
    const current = readAuth(env)?.hash ?? "";
    if (current === authHash) return;
    authHash = current;
    sessions.clear();
    failures.clear();
    globalFailures = { count: 0, windowEnds: 0, lastTry: 0 };
  };
  const loginBlock = (ip: string): string | null => {
    const record = failures.get(ip);
    if (record && record.until > now()) return "试错太多次了，15 分钟后再试。";
    if (globalFailures.windowEnds > now() && globalFailures.count >= 50 && now() - globalFailures.lastTry < 5) return "最近登录失败太多，请过几秒再试。";
    return null;
  };

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

  // 链接等于交出管理权，只有「只能用链接绑定」时才给网页显示
  const botView = (info: BotInfo) => ({ ...info, link: info.claimMode === "link" && info.claimOpen ? info.link : undefined, state: options.stateOf(info.name), canDelete: info.name !== DEFAULT_NAME, chatLink: info.username ? `https://t.me/${info.username}` : "" });

  const requireBot = (name: string) => {
    if (!allNames(env).includes(name)) throw new HttpError(404, "没有这个机器人。");
    return name;
  };

  const readBotSettings = async (name: string) => {
    const db = sqliteDb(dbPath(env, name));
    try {
      const s = await loadSettings(db);
      return { welcome: s.welcome, verify: s.verifyMode === "quiz", hasImage: s.welcomeImage, uiCleanHours: s.uiCleanHours };
    } finally {
      db.close();
    }
  };

  async function schedulesApi(req: IncomingMessage, name: string, method: string, rawId: string | undefined, sub: string | undefined): Promise<unknown> {
    const db = sqliteDb(dbPath(env, name));
    const nowSeconds = now();
    try {
      const settings = await loadSettings(db);
      const timezone = settings.timezone;
      const view = (item: Schedule) => ({ id: item.id, text: item.text, hasImage: item.hasAsset || item.photoId !== "", enabled: item.enabled, when: describeRepeat(item, timezone), state: scheduleState(item, timezone), canToggle: item.enabled || item.repeat !== "once" || item.lastRun === null });
      if (rawId === undefined) {
        if (method === "GET") return { schedules: (await listSchedules(db)).map(view), recipients: await countRecipients(db, settings.ownerId), timezone };
        if (method !== "POST") throw new HttpError(404, "没有这个接口。");
        const body = await readJson(req, MAX_UPLOAD_BODY);
        const parsed = parseImage(text(body.image));
        const content = text(body.text);
        if (!parsed && !content.trim()) throw new HttpError(400, "写点文字或者选一张图片。");
        if (parsed && content.length > CAPTION_LIMIT) throw new HttpError(400, `带图片时文字最多 ${CAPTION_LIMIT} 字（Telegram 的限制）。`);
        if (content.length > TEXT_LIMIT) throw new HttpError(400, `文字太长了，请控制在 ${TEXT_LIMIT} 字以内。`);
        const kind = text(body.repeat);
        if (kind !== "once" && kind !== "daily" && kind !== "weekly") throw new HttpError(400, "选一下多久发一次。");
        const content2 = { text: content, ...(parsed ? { asset: { mime: parsed.mime, data: parsed.bytes.toString("base64") } } : {}) };
        let plan: Parameters<typeof activateSchedule>[2];
        if (kind === "once") {
          const once = parseOnce(`${text(body.date)} ${text(body.time)}`.trim(), timezone, nowSeconds);
          if (typeof once === "string") throw new HttpError(400, once);
          plan = { repeat: "once", ...once };
        } else {
          const times = parseTimes(Array.isArray(body.times) ? body.times.map(text).join(" ") : "");
          if (typeof times === "string") throw new HttpError(400, times);
          const weekdays = Array.isArray(body.weekdays) ? [...new Set(body.weekdays.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [];
          if (kind === "weekly" && weekdays.length === 0) throw new HttpError(400, "至少选一天。");
          plan = { repeat: kind, times, weekdays };
        }
        const id = await createDraft(db, content2, nowSeconds);
        await activateSchedule(db, id, plan, timezone, nowSeconds);
        const created = await getSchedule(db, id);
        return created ? view(created) : {};
      }
      const id = Number(rawId);
      const item = await getSchedule(db, id);
      if (!item) throw new HttpError(404, "这条定时已经没有了。");
      if (method === "DELETE" && !sub) {
        await deleteSchedule(db, id, nowSeconds);
        return { ok: true };
      }
      if (method === "POST" && sub === "toggle") {
        const failure = await toggleSchedule(db, item, timezone, nowSeconds);
        if (failure) throw new HttpError(400, failure);
        const fresh = await getSchedule(db, id);
        return fresh ? view(fresh) : {};
      }
      throw new HttpError(404, "没有这个接口。");
    } finally {
      db.close();
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<unknown> {
    const method = req.method ?? "GET";
    syncAuth();
    if (path === "/api/login" && method === "POST") {
      const ip = clientIp(req);
      const early = loginBlock(ip);
      if (early) throw new HttpError(429, early);
      const body = await readJson(req);
      const auth = readAuth(env);
      if (!auth) throw new HttpError(503, "还没有设置账号，在服务器上运行 tgbot web-password。");
      // 读完请求体再查一次，并先记上这次尝试：同时发一大批也只有前几个能进来算密码
      const blocked = loginBlock(ip);
      if (blocked) throw new HttpError(429, blocked);
      const count = (failures.get(ip)?.count ?? 0) + 1;
      failures.set(ip, { count, until: count >= 5 ? now() + 900 : 0 });
      if (globalFailures.windowEnds <= now()) globalFailures = { count: 0, windowEnds: now() + 900, lastTry: 0 };
      globalFailures.count++;
      globalFailures.lastTry = now();
      if (!(await verify(auth, text(body.user), text(body.password)))) throw new HttpError(401, "账号或密码不对。");
      failures.delete(ip);
      globalFailures.count = Math.max(0, globalFailures.count - 1);
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
      if (!auth || !(await verify(auth, auth.user, text(body.current)))) throw new HttpError(400, "当前密码不对。");
      setAuth(env, text(body.user) || auth.user, text(body.password));
      authHash = readAuth(env)?.hash ?? "";
      // 其他设备的登录作废，只留当前这个
      for (const id of sessions.keys()) if (id !== session) sessions.delete(id);
      return { ok: true };
    }
    if (path === "/api/bots" && method === "GET") {
      const names = allNames(env);
      const bots = await Promise.all(names.map(async (name) => botView(await describeSafely(env, name))));
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
    const match = /^\/api\/bots\/([^/]+)(?:\/(assign|token|settings|image|schedules)(?:\/(\d+)(?:\/(toggle))?)?)?$/.exec(path);
    if (!match) throw new HttpError(404, "没有这个接口。");
    const name = requireBot(decodeURIComponent(match[1] ?? ""));
    const action = match[2];
    if (action === "schedules") return await schedulesApi(req, name, method, match[3], match[4]);
    if (match[3]) throw new HttpError(404, "没有这个接口。");
    if (!action && method === "DELETE") {
      removeBot(env, name);
      return { ok: true };
    }
    if (action === "assign" && method === "POST") {
      const body = await readJson(req);
      return botView(await assignOwner(env, name, text(body.user)));
    }
    if (action === "token" && method === "POST") {
      const body = await readJson(req);
      if (name === DEFAULT_NAME) throw new HttpError(400, "默认机器人的 Token 在服务器上用 tgbot token 更换。");
      await replaceToken(env, name, text(body.token));
      return { ok: true };
    }
    if (action === "image" && method === "GET") {
      const db = sqliteDb(dbPath(env, name));
      try {
        const asset = await db.prepare("SELECT mime, data FROM assets WHERE name = 'welcome'").first<{ mime: unknown; data: unknown }>();
        return { data: asset ? `data:${text(asset.mime)};base64,${text(asset.data)}` : "" };
      } finally {
        db.close();
      }
    }
    if (action === "settings") {
      if (method === "GET") return await readBotSettings(name);
      if (method === "POST") {
        const body = await readJson(req, MAX_UPLOAD_BODY);
        const db = sqliteDb(dbPath(env, name));
        try {
          const settings = await loadSettings(db);
          // 先校验再写，一项不对就都不改
          const parsed = parseImage(text(body.image));
          const bytes = parsed ? parsed.bytes : null;
          const upload = parsed ? [ "", parsed.mime ] : null;
          const willHaveImage = bytes !== null || (settings.welcomeImage && body.removeImage !== true);
          if (typeof body.welcome === "string") {
            if ((!body.welcome.trim() && !willHaveImage) || body.welcome.length > 2000) throw new HttpError(400, "自动回复不能是空的（有图片时可以不写字），也不能超过 2000 字。");
            await saveSetting(db, settings, "welcome", body.welcome);
          }
          if (body.removeImage === true || (bytes && upload)) {
            await db.prepare("DELETE FROM assets WHERE name = 'welcome'").run();
            await saveSetting(db, settings, "welcomePhotoId", "");
            await saveSetting(db, settings, "welcomeImage", false);
          }
          if (bytes && upload) {
            await db.prepare("INSERT INTO assets(name, mime, data) VALUES('welcome', ?, ?)").bind(upload[1] ?? "", bytes.toString("base64")).run();
            await saveSetting(db, settings, "welcomeImage", true);
          }
          if (typeof body.uiCleanHours === "number" && [0, 1, 6, 24].includes(body.uiCleanHours)) await saveSetting(db, settings, "uiCleanHours", body.uiCleanHours);
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
    // 这里抛错没人接，整个进程连同所有机器人都会退出，所以怪输入一律当坏请求
    if (!URL.canParse(req.url ?? "/", "https://local")) {
      res.writeHead(400).end();
      return;
    }
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
    if (req.method !== "GET" && origin !== undefined && (!URL.canParse(origin) || new URL(origin).host !== req.headers.host)) {
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
