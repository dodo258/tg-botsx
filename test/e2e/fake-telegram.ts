// 假的 Telegram HTTP 服务，端到端测试用。记录所有调用，getUpdates 从队列里取。
import { createServer } from "node:http";
import type { Server } from "node:http";

export interface FakeServer {
  url: string;
  calls: { method: string; body: Record<string, unknown> }[];
  queue: unknown[];
  webhook: { url: string; secret: string };
  named(method: string): Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startFakeTelegram(token: string, listen: { host: string; port: number; publicHost?: string } = { host: "127.0.0.1", port: 0 }): Promise<FakeServer> {
  const calls: FakeServer["calls"] = [];
  const queue: unknown[] = [];
  const webhook = { url: "", secret: "" };
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
      if (!match || match[1] !== token) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
      const method = match[2] ?? "";
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        // 上传文件是 multipart，不解析
      }
      if (method !== "getUpdates") calls.push({ method, body });
      const ok = (result: unknown) => send(200, { ok: true, result });
      switch (method) {
        case "getMe":
          return ok({ id: 42, is_bot: true, first_name: "传声筒", username: "demo_bot", has_topics_enabled: false });
        case "getUpdates": {
          const updates = queue.splice(0);
          // 真实服务器会挂起直到有更新；这里短暂等待，避免空转
          return setTimeout(() => ok(updates), updates.length ? 0 : 150);
        }
        case "setWebhook":
          webhook.url = String(body.url);
          webhook.secret = String(body.secret_token);
          return ok(true);
        case "getWebhookInfo":
          return ok({ url: webhook.url, pending_update_count: 0 });
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
    calls,
    queue,
    webhook,
    named: (method) => calls.filter((call) => call.method === method).map((call) => call.body),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
