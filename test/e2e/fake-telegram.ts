// 假的 Telegram HTTP 服务，端到端测试用。记录所有调用，getUpdates 从队列里取。
import { createServer } from "node:http";
import type { Server } from "node:http";

export interface FakeServer {
  url: string;
  calls: { method: string; body: Record<string, unknown> }[];
  queue: unknown[];
  named(method: string): Record<string, unknown>[];
  /** 再加一个机器人，它有自己的队列和调用记录 */
  addBot(token: string, username: string): FakeBot;
  close(): Promise<void>;
}

export interface FakeBot {
  calls: { method: string; body: Record<string, unknown> }[];
  queue: unknown[];
  named(method: string): Record<string, unknown>[];
}

export async function startFakeTelegram(token: string, listen: { host: string; port: number; publicHost?: string } = { host: "127.0.0.1", port: 0 }): Promise<FakeServer> {
  const makeBot = (username: string) => {
    const calls: FakeBot["calls"] = [];
    return { username, calls, queue: [] as unknown[], named: (method: string) => calls.filter((call) => call.method === method).map((call) => call.body) };
  };
  const main = makeBot("demo_bot");
  const bots = new Map([[token, main]]);
  let nextId = 9000;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const match = /^\/bot([^/]+)\/(\w+)/.exec(req.url ?? "");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const bot = bots.get(match?.[1] ?? "");
      if (!match || !bot) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
      const method = match[2] ?? "";
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        // 上传文件是 multipart，不解析
      }
      if (method !== "getUpdates") bot.calls.push({ method, body });
      const ok = (result: unknown) => send(200, { ok: true, result });
      switch (method) {
        case "getMe":
          return ok({ id: 42, is_bot: true, first_name: "传声筒", username: bot.username, has_topics_enabled: false });
        case "getUpdates": {
          const updates = bot.queue.splice(0);
          // 真实服务器会挂起直到有更新；这里短暂等待，避免空转
          return setTimeout(() => ok(updates), updates.length ? 0 : 150);
        }
        case "sendMessage":
        case "copyMessage":
        case "forwardMessage":
        case "sendDocument":
          return ok({ message_id: nextId++ });
        case "copyMessages":
          return ok((Array.isArray(body.message_ids) ? body.message_ids : []).map(() => ({ message_id: nextId++ })));
        case "createForumTopic":
          return ok({ message_thread_id: nextId++, name: body.name });
        default:
          return ok(true);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(listen.port, listen.host, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假服务没有监听端口");
  return {
    url: `http://${listen.publicHost ?? listen.host}:${address.port}`,
    calls: main.calls,
    queue: main.queue,
    named: main.named,
    addBot(extra, username) {
      const bot = makeBot(username);
      bots.set(extra, bot);
      return bot;
    },
    close: () =>
      new Promise((resolve) => {
        // 机器人的长轮询连接还挂着，不断开的话 close 永远不返回
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
