// 很薄的 Bot API 客户端：只管发请求、超时、429 重试和错误归类，不做业务判断。

export type Params = Record<string, unknown>;

export class TelegramError extends Error {
  readonly method: string;
  readonly code: number;
  readonly description: string;
  readonly retryAfter: number | null;
  constructor(method: string, code: number, description: string, retryAfter: number | null) {
    super(`Telegram ${method} 失败（${code}）：${description}`);
    this.name = "TelegramError";
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
  /** 对方拉黑了机器人、注销了账号，或从未和机器人说过话 */
  get userUnreachable(): boolean {
    return (
      this.code === 403 ||
      /chat not found|user is deactivated|PEER_ID_INVALID/i.test(this.description)
    );
  }
  get threadMissing(): boolean {
    return /message thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(this.description);
  }
  get threadClosed(): boolean {
    return /TOPIC_CLOSED/i.test(this.description);
  }
  get notModified(): boolean {
    return /message is not modified/i.test(this.description);
  }
  get messageMissing(): boolean {
    return /message to (edit|delete|copy|forward) not found|message can't be (edited|deleted)|MESSAGE_ID_INVALID/i.test(
      this.description,
    );
  }
}

export interface TelegramOptions {
  token: string;
  apiBase?: string;
  /** 单次请求超时，毫秒 */
  timeoutMs?: number;
  /** 被限流时最多等多少秒再重试；超过就抛错交给调用方 */
  maxRetryAfter?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface Telegram {
  call<T = unknown>(method: string, params?: Params): Promise<T>;
  upload<T = unknown>(method: string, params: Params, field: string, file: Uint8Array<ArrayBuffer>, name: string, type: string): Promise<T>;
}

const DEFAULT_API = "https://api.telegram.org";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createTelegram(options: TelegramOptions): Telegram {
  const base = (options.apiBase ?? DEFAULT_API).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 25_000;
  const maxRetryAfter = options.maxRetryAfter ?? 5;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const urlFor = (method: string) => `${base}/bot${options.token}/${method}`;

  async function request<T>(method: string, makeInit: () => RequestInit, attempt = 0): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(urlFor(method), { ...makeInit(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // 错误信息里不能带 URL，URL 含 Token。
      const reason = error instanceof Error ? error.name : "未知错误";
      throw new TelegramError(method, 0, `网络请求失败：${reason}`, null);
    }
    const body: unknown = await response.json().catch(() => null);
    if (isRecord(body) && body.ok === true) return narrow<T>(body.result);
    const description = isRecord(body) && typeof body.description === "string" ? body.description : `HTTP ${response.status}`;
    const parameters = isRecord(body) && isRecord(body.parameters) ? body.parameters : null;
    const retryAfter = parameters && typeof parameters.retry_after === "number" ? parameters.retry_after : null;
    if (response.status === 429 && retryAfter !== null && retryAfter <= maxRetryAfter && attempt < 2) {
      await sleep(retryAfter * 1000);
      return request<T>(method, makeInit, attempt + 1);
    }
    throw new TelegramError(method, response.status, description, retryAfter);
  }

  return {
    call<T>(method: string, params: Params = {}) {
      const body = JSON.stringify(params);
      return request<T>(method, () => ({
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }));
    },
    upload<T>(method: string, params: Params, field: string, file: Uint8Array<ArrayBuffer>, name: string, type: string) {
      return request<T>(method, () => {
        const form = new FormData();
        for (const [key, value] of Object.entries(params)) {
          form.set(key, typeof value === "string" ? value : JSON.stringify(value));
        }
        form.set(field, new Blob([file], { type }), name);
        return { method: "POST", body: form };
      });
    },
  };
}

// Bot API 的返回结构由方法决定，泛型 T 由调用方按官方文档声明。
function narrow<T>(value: unknown): T {
  return value as T;
}
