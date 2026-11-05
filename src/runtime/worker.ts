// Cloudflare Workers 入口。Webhook 收更新，Cron 跑定时任务，设置页负责首次接线。
import type { App } from "../core/app.ts";
import { tick } from "../core/maintenance.ts";
import { handleUpdate, isUpdate } from "../core/router.ts";
import { migrate } from "../core/schema.ts";
import { loadSettings } from "../core/settings.ts";
import { handleSetup, handleSetupStatus, safeEqual, webhookSecret } from "../core/setup.ts";
import { createTelegram } from "../core/telegram.ts";
import { cryptoRng } from "../core/verify.ts";
import { setupPage } from "../web/setup-page.ts";
import { d1Db } from "./d1-adapter.ts";

interface Env {
  DB: D1Database;
  BOT_TOKEN?: string;
  TELEGRAM_API_BASE?: string;
}

let migrated: Promise<void> | null = null;

function ensureMigrated(env: Env): Promise<void> {
  if (!migrated) {
    migrated = migrate(d1Db(env.DB)).catch((error: unknown) => {
      // 失败后下一个请求重试
      migrated = null;
      throw error;
    });
  }
  return migrated;
}

async function buildApp(env: Env, token: string, ctx: ExecutionContext): Promise<App> {
  await ensureMigrated(env);
  const db = d1Db(env.DB);
  const settings = await loadSettings(db);
  return {
    db,
    tg: createTelegram({ token, apiBase: env.TELEGRAM_API_BASE }),
    settings,
    rng: cryptoRng,
    now: () => Math.floor(Date.now() / 1000),
    nowMs: () => Date.now(),
    defer(task, delayMs) {
      ctx.waitUntil(
        new Promise<void>((resolve) => setTimeout(resolve, delayMs))
          .then(task)
          .catch((error: unknown) => {
            console.error("后台任务失败", error instanceof Error ? error.message : String(error));
          }),
      );
    },
    log(level, message, detail) {
      const line = detail === undefined ? message : `${message}：${String(detail)}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function html(nonce: string): Response {
  return new Response(setupPage(nonce), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function readToken(request: Request): Promise<unknown> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && "token" in body ? body.token : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /health") return json({ ok: true });
    const token = env.BOT_TOKEN?.trim();
    if (route === "GET /") return html(crypto.randomUUID().replaceAll("-", ""));
    if (!token) return json({ ok: false, error: "还没有配置 BOT_TOKEN。到 Worker 设置 → 变量和机密里添加后再试。" }, 500);

    if (route === "POST /setup") {
      const app = await buildApp(env, token, ctx);
      const result = await handleSetup(app, token, await readToken(request), `${url.origin}/telegram/webhook`);
      return json(result.body, result.status);
    }
    if (route === "POST /setup/status") {
      const app = await buildApp(env, token, ctx);
      const result = await handleSetupStatus(app, token, await readToken(request));
      return json(result.body, result.status);
    }
    if (route === "POST /telegram/webhook") {
      // 校验来源：没有这一步，任何人都能伪造管理员操作
      const expected = await webhookSecret(token);
      const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!(await safeEqual(provided, expected))) return json({ ok: false }, 401);
      const update: unknown = await request.json().catch(() => null);
      if (!isUpdate(update)) return json({ ok: false }, 400);
      const app = await buildApp(env, token, ctx);
      await handleUpdate(app, update, "Cloudflare Workers");
      return json({ ok: true });
    }
    return json({ ok: false }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const token = env.BOT_TOKEN?.trim();
    if (!token) return;
    const app = await buildApp(env, token, ctx);
    await tick(app, { webhookToken: token, minute: new Date(event.scheduledTime).getUTCMinutes() });
  },
};

