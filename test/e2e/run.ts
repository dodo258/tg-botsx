// 端到端：起真实的 Node 进程，对着假 Telegram 跑一遍。
// 运行：npm run e2e
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeTelegram } from "./fake-telegram.ts";
import type { FakeServer } from "./fake-telegram.ts";

const TOKEN = "123456:TEST_TOKEN_for_e2e";
const OWNER = 1000;
const ALICE = 2001;
const BOB = 2002;
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "通过" : "失败"}  ${name}${ok || detail === undefined ? "" : `\n      实际：${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, test: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await test()) return true;
    await sleep(100);
  }
  console.log(`等待超时：${what}`);
  return false;
}

function start(command: string, args: string[], env: Record<string, string>, log: string[]): ChildProcess {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  return child;
}

let updateId = 1;
function textUpdate(userId: number, text: string, messageId: number): Record<string, unknown> {
  return { update_id: updateId++, message: { message_id: messageId, date: 1, chat: { id: userId, type: "private" }, from: { id: userId, is_bot: false, first_name: `用户${userId}` }, text } };
}

async function testNode(fake: FakeServer): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "tg-botsx-node-"));
  const env = { BOT_TOKEN: TOKEN, DATA_DIR: dataDir, TELEGRAM_API_BASE: fake.url, NODE_NO_WARNINGS: "1" };
  const log: string[] = [];
  const entry = "src/runtime/node.ts";
  const node = start("node", [entry], env, log);
  try {
    const linked = await waitFor("打印认领链接", () => log.join("").includes("start=claim_"));
    check("启动后打印认领链接", linked, log.join(""));
    check("启动后打印配对图案", /配对图案：\S+ \S+/.test(log.join("")), log.join(""));
    check("启动时删除旧 Webhook", fake.named("deleteWebhook").length === 1);
    const code = /claim_([\w-]+)/.exec(log.join(""))?.[1] ?? "";

    fake.queue.push(textUpdate(OWNER, `/start claim_${code}`, 1));
    check("长轮询收到认领并绑定", await waitFor("绑定", () => fake.named("sendMessage").some((m) => String(m.text).includes("绑定成功"))));

    fake.queue.push(textUpdate(ALICE, "你好", 2));
    check("陌生人收到验证题", await waitFor("验证题", () => fake.named("sendMessage").some((m) => m.chat_id === ALICE && String(m.text).includes("答一道题"))));

    fake.queue.push(textUpdate(OWNER, "/status", 3));
    check("管理员命令可用", await waitFor("状态", () => fake.named("sendMessage").some((m) => String(m.text).includes("运行状态"))));

    const before = fake.calls.length;
    node.kill("SIGTERM");
    const exited = await waitFor("进程退出", () => node.exitCode !== null, 8000);
    check("收到 SIGTERM 能正常退出", exited && node.exitCode === 0, node.exitCode);
    check("退出时没有多余调用", fake.calls.length === before);

    // 重启：数据还在，不再要求认领
    const secondLog: string[] = [];
    const second = start("node", [entry], env, secondLog);
    const connected = await waitFor("重启", () => secondLog.join("").includes("已连接"));
    check("重启后数据还在，不再打印认领链接", connected && !secondLog.join("").includes("start=claim_"), secondLog.join(""));

    const backup = join(dataDir, "backup.db");
    const backupProcess = start("node", [entry, "backup", backup], env, []);
    await waitFor("备份完成", () => backupProcess.exitCode !== null);
    check("运行中可以在线备份", backupProcess.exitCode === 0 && existsSync(backup));

    const claimProcessLog: string[] = [];
    const claimProcess = start("node", [entry, "claim"], env, claimProcessLog);
    await waitFor("生成认领链接", () => claimProcess.exitCode !== null);
    check("claim 命令能重新生成链接", claimProcess.exitCode === 0 && claimProcessLog.join("").includes("start=claim_"), claimProcessLog.join(""));

    // 同一个进程再加两个机器人：不重启就生效，数据各在各的文件里
    const SHOP = "222222:SHOP_TOKEN_for_e2e";
    const TEAM = "333333:TEAM_TOKEN_for_e2e";
    const shop = fake.addBot(SHOP, "shop_bot");
    const team = fake.addBot(TEAM, "team_bot");
    const addVia = async (token: string, ...args: string[]) => {
      const out: string[] = [];
      const child = spawn("node", [entry, "add", ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => out.push(chunk.toString()));
      child.stdin.end(`${token}\n`);
      await waitFor("add 结束", () => child.exitCode !== null);
      return { code: child.exitCode, out: out.join("") };
    };
    const added = await addVia(SHOP);
    check("add 用机器人的用户名起名", added.code === 0 && added.out.includes("shop-bot") && !added.out.includes(SHOP), added.out);
    const duplicate = await addVia(SHOP);
    check("同一个 Token 不能加两次", duplicate.code === 1 && duplicate.out.includes("已经给「shop-bot」用了"), duplicate.out);
    const sameAsDefault = await addVia(TOKEN);
    check("默认机器人的 Token 也不能再加", sameAsDefault.code === 1 && sameAsDefault.out.includes("已经给「默认」用了"), sameAsDefault.out);
    const invalid = await addVia("999999:not_a_real_token_x");
    check("无效 Token 报中文原因", invalid.code === 1 && invalid.out.includes("不认这个 Token"), invalid.out);
    check("加第二个", (await addVia(TEAM, "team", "someone")).code === 0);
    check("进程不重启就开始跑新机器人", await waitFor("新机器人连接", () => secondLog.join("").includes("已连接 @shop_bot") && secondLog.join("").includes("已连接 @team_bot")));

    shop.queue.push(textUpdate(ALICE, "你好", 11));
    check("朋友私聊看到成为管理员按钮", await waitFor("按钮", () => shop.named("sendMessage").some((m) => m.chat_id === ALICE && String(m.text).includes("还没有管理员"))));
    team.queue.push(textUpdate(ALICE, "你好", 12));
    await sleep(800);
    check("指定了用户名的机器人不给别人按钮", !team.named("sendMessage").some((m) => String(m.text).includes("还没有管理员")));
    shop.queue.push({ update_id: updateId++, callback_query: { id: "c", from: { id: ALICE, is_bot: false, first_name: "朋友" }, chat_instance: "x", data: "claim", message: { message_id: 50, date: 1, chat: { id: ALICE, type: "private" } } } });
    check("朋友点一下成为管理员", await waitFor("朋友绑定", () => shop.named("sendMessage").some((m) => String(m.text).includes("绑定成功"))));
    check("朋友绑定不影响默认机器人的管理员", !fake.named("sendMessage").some((m) => m.chat_id === ALICE && String(m.text).includes("绑定成功")));
    const listOut: string[] = [];
    const lister = start("node", [entry, "list"], env, listOut);
    await waitFor("list", () => lister.exitCode !== null);
    check("list 列出三个并显示绑定状态", /默认\t@demo_bot/.test(listOut.join("")) && /shop-bot\t@shop_bot\t已绑定 朋友/.test(listOut.join("")) && /team\t@team_bot\t等 @someone 绑定/.test(listOut.join("")), listOut.join(""));
    check("数据文件是分开的", existsSync(join(dataDir, "bots", "shop-bot", "relay.db")) && existsSync(join(dataDir, "bots", "team", "relay.db")));
    // 一个机器人的数据库坏了：它这一行显示故障，别的照常，能删掉
    writeFileSync(join(dataDir, "bots", "team", "relay.db"), "这不是数据库，".repeat(400));
    rmSync(join(dataDir, "bots", "team", "relay.db-wal"), { force: true });
    rmSync(join(dataDir, "bots", "team", "relay.db-shm"), { force: true });
    const brokenOut: string[] = [];
    const brokenList = start("node", [entry, "list"], env, brokenOut);
    await waitFor("list", () => brokenList.exitCode !== null);
    check("数据库坏了 list 也能列完", brokenList.exitCode === 0 && /team\t-\t数据库打不开/.test(brokenOut.join("")) && brokenOut.join("").includes("shop-bot"), brokenOut.join(""));
    const removed = start("node", [entry, "remove", "team"], env, []);
    await waitFor("remove", () => removed.exitCode !== null);
    check("删除一个不影响其他", removed.exitCode === 0 && !existsSync(join(dataDir, "bots", "team")) && existsSync(join(dataDir, "bots", "shop-bot", "relay.db")));
    await sleep(3500);
    const callsAfterRemove = shop.calls.length;
    shop.queue.push(textUpdate(BOB, "你好", 13));
    check("删除后别的机器人照常工作", await waitFor("其他机器人", () => shop.calls.length > callsAfterRemove));

    const conflictFree = secondLog.join("");
    second.kill("SIGTERM");
    await waitFor("第二个进程退出", () => second.exitCode !== null, 8000);
    check("日志没有泄露 Token", !conflictFree.includes(TOKEN) && !log.join("").includes(TOKEN));

    const badLog: string[] = [];
    const bad = start("node", [entry], { ...env, BOT_TOKEN: "111:bad", DATA_DIR: mkdtempSync(join(tmpdir(), "tg-botsx-bad-")) }, badLog);
    await waitFor("坏 Token 退出", () => bad.exitCode !== null);
    check("Token 无效时报中文错误并退出", bad.exitCode === 1 && badLog.join("").includes("不认这个 Token"), badLog.join(""));

    const noneLog: string[] = [];
    const none = start("node", [entry], { ...env, BOT_TOKEN: "", DATA_DIR: mkdtempSync(join(tmpdir(), "tg-botsx-none-")) }, noneLog);
    await waitFor("缺 Token 退出", () => none.exitCode !== null);
    check("没配 Token 时报中文错误并退出", none.exitCode === 1 && noneLog.join("").includes("没有配置 BOT_TOKEN"), noneLog.join(""));
  } finally {
    node.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testWeb(fake: FakeServer): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "tg-botsx-web-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { BOT_TOKEN: "", DATA_DIR: dataDir, TELEGRAM_API_BASE: fake.url, WEB_LISTEN_PORT: String(port), NODE_NO_WARNINGS: "1" };
  const entry = "src/runtime/node.ts";
  const WEB_TOKEN = "444444:WEB_TOKEN_for_e2e_x";
  const friend = fake.addBot(WEB_TOKEN, "friend_bot");
  const log: string[] = [];
  const node = start("node", [entry], env, log);
  let cookie = "";
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; data: Record<string, unknown>; raw: string; setCookie: string }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpsRequest({ host: "127.0.0.1", port, path, method, rejectUnauthorized: false, headers: { ...(payload ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        res.on("end", () => {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // 页面不是 JSON
          }
          resolve({ status: res.statusCode ?? 0, data, raw, setCookie: String(res.headers["set-cookie"]?.[0] ?? "") });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  try {
    check("没配机器人也能启动网页", await waitFor("网页启动", () => log.join("").includes("网页管理已启动")), log.join(""));
    const page = await call("GET", "/");
    check("页面能打开，是 HTTPS", page.status === 200 && page.raw.includes("传声筒"));
    check("没登录拿不到机器人列表", (await call("GET", "/api/bots")).status === 401);
    check("还没设账号时不能登录", (await call("POST", "/api/login", { user: "a", password: "b" })).status === 503);

    const auth = spawn("node", [entry, "web-auth"], { env: { ...process.env, ...env }, stdio: ["pipe", "ignore", "ignore"] });
    auth.stdin.end("tester\nlocal-e2e-password\n");
    await waitFor("设置账号", () => auth.exitCode !== null);
    check("账号文件没有明文密码", !readFileSync(join(dataDir, "web", "auth.json"), "utf8").includes("local-e2e-password"));
    const denied = await call("POST", "/api/login", { user: "tester", password: "wrong-password" });
    check("密码不对不能登录", denied.status === 401 && denied.setCookie === "");
    const login = await call("POST", "/api/login", { user: "tester", password: "local-e2e-password" });
    check("登录成功，Cookie 带安全属性", login.status === 200 && /HttpOnly; Secure; SameSite=Strict/.test(login.setCookie), login.setCookie);
    cookie = login.setCookie.split(";")[0] ?? "";

    const nullOrigin = await call("POST", "/api/login", { user: "x", password: "y" }, { origin: "null" });
    check("带奇怪 Origin 的请求被拒绝，进程不崩", nullOrigin.status === 403 && node.exitCode === null, nullOrigin.raw);
    const weirdPath = await call("GET", "//");
    check("奇怪路径的请求不会把进程打崩", weirdPath.status >= 400 && node.exitCode === null, weirdPath.status);
    check("跨站来源的写操作被拒绝", (await call("POST", "/api/bots", { tokens: WEB_TOKEN }, { origin: "https://evil.example" })).status === 403);
    const added = await call("POST", "/api/bots", { tokens: `${WEB_TOKEN}\n999:bad` });
    const results = added.data.results as { ok: boolean }[];
    check("一次粘贴多个，好的加上，坏的说原因", results.length === 2 && results[0]?.ok === true && results[1]?.ok === false, added.raw);
    check("响应里没有 Token", !added.raw.includes(WEB_TOKEN));
    check("新机器人不用重启就连上", await waitFor("连接", () => log.join("").includes("已连接 @friend_bot")));
    const listed = await call("GET", "/api/bots");
    check("列表里没有 Token", listed.status === 200 && !listed.raw.includes(WEB_TOKEN) && listed.raw.includes("friend_bot"), listed.raw);

    friend.queue.push(textUpdate(ALICE, "你好", 21));
    check("朋友私聊看到按钮", await waitFor("按钮", () => friend.named("sendMessage").some((m) => String(m.text).includes("还没有管理员"))));
    friend.queue.push({ update_id: updateId++, callback_query: { id: "c", from: { id: ALICE, is_bot: false, first_name: "朋友", username: "alice" }, chat_instance: "x", data: "claim", message: { message_id: 50, date: 1, chat: { id: ALICE, type: "private" } } } });
    await waitFor("绑定", () => friend.named("sendMessage").some((m) => String(m.text).includes("绑定成功")));
    const after = await call("GET", "/api/bots");
    check("网页能看到是谁绑定的", after.raw.includes("朋友") && after.raw.includes('"bound":true'), after.raw);

    const bad = await call("POST", "/api/bots/friend-bot/assign", { user: "not valid!" });
    const still = await call("GET", "/api/bots");
    check("用户名不对时不会把现有管理员清掉", bad.status === 400 && still.raw.includes('"bound":true'), bad.raw);
    const assign = await call("POST", "/api/bots/friend-bot/assign", { user: "@ZhangSan" });
    check("网页能重新指定管理员", assign.status === 200 && assign.data.claimUser === "zhangsan" && assign.data.bound === false, assign.raw);

    await sleep(200);
    friend.calls.length = 0;
    friend.queue.push(textUpdate(BOB, "你好", 22));
    await sleep(700);
    check("指定后别人看不到按钮", !friend.named("sendMessage").some((m) => String(m.text).includes("还没有管理员")));
    const blank = await call("POST", "/api/bots/friend-bot/assign", { user: "" });
    check("已有联系人的机器人留空时只给链接，不开放给谁先点算谁", blank.data.claimMode === "link" && String(blank.data.link).includes("start=claim_"), blank.raw);


    const saved = await call("POST", "/api/bots/friend-bot/settings", { welcome: "朋友的欢迎语", verify: false });
    check("网页能改欢迎语和验证开关", saved.data.welcome === "朋友的欢迎语" && saved.data.verify === false, saved.raw);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const uploaded = await call("POST", "/api/bots/friend-bot/settings", { image: png });
    check("网页能上传图片", uploaded.status === 200 && uploaded.data.hasImage === true, uploaded.raw);
    check("上传的图片能读回来", (await call("GET", "/api/bots/friend-bot/image")).data.data === png);
    const notImage = await call("POST", "/api/bots/friend-bot/settings", { image: "data:image/png;base64,bm90IGltYWdl" });
    check("假图片被拒绝", notImage.status === 400 && notImage.raw.includes("不是有效的图片"), notImage.raw);
    check("没登录拿不到图片", (await (async () => { const saved = cookie; cookie = ""; const r = await call("GET", "/api/bots/friend-bot/image"); cookie = saved; return r; })()).status === 401);
    const noImage = await call("POST", "/api/bots/friend-bot/settings", { removeImage: true });
    check("网页能去掉图片", noImage.data.hasImage === false, noImage.raw);
    check("删不存在的机器人报错", (await call("DELETE", "/api/bots/nope")).status === 404);
    check("路径穿越被挡住", (await call("DELETE", "/api/bots/..%2F..%2Fweb")).status === 404);
    const deleted = await call("DELETE", "/api/bots/friend-bot");
    check("网页能删除机器人", deleted.status === 200 && !existsSync(join(dataDir, "bots", "friend-bot")));

    const wrongCurrent = await call("POST", "/api/password", { current: "nope-nope", password: "another-password" });
    check("改密码要当前密码", wrongCurrent.status === 400);
    // 在别的进程改密码（tgbot web-password）：旧登录立刻失效
    const reset = spawn("node", [entry, "web-auth"], { env: { ...process.env, ...env }, stdio: ["pipe", "ignore", "ignore"] });
    reset.stdin.end("tester\\nlocal-e2e-password-2\\n".replaceAll("\\n", "\n"));
    await waitFor("重设密码", () => reset.exitCode !== null);
    check("服务器上重设密码后，旧登录失效", (await call("GET", "/api/bots")).status === 401);
    const relogin = await call("POST", "/api/login", { user: "tester", password: "local-e2e-password-2" });
    cookie = relogin.setCookie.split(";")[0] ?? "";
    // 一批并发的错密码只有前几个进得了校验
    const flood = await Promise.all(Array.from({ length: 30 }, () => call("POST", "/api/login", { user: "tester", password: "wrong-password" }, { cookie: "" })));
    check("并发错密码也会被锁定", flood.filter((item) => item.status === 401).length <= 5 && flood.filter((item) => item.status === 429).length >= 25, flood.map((item) => item.status).join());
    await call("POST", "/api/login", { user: "tester", password: "local-e2e-password-2" });
    const logout = await call("POST", "/api/logout");
    cookie = "";
    check("退出后不能再用", logout.status === 200 && (await call("GET", "/api/bots")).status === 401);
    check("连错 5 次被锁", (await call("POST", "/api/login", { user: "tester", password: "local-e2e-password-2" })).status === 429);
    check("日志里没有 Token 和密码", !log.join("").includes(WEB_TOKEN) && !log.join("").includes("local-e2e-password"));
  } finally {
    node.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 镜像里跑的是转好的 JS，和开发时不是同一份文件，要单独确认能跑。 */
async function testBuilt(fake: FakeServer): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), "tg-botsx-dist-"));
  const dataDir = mkdtempSync(join(tmpdir(), "tg-botsx-built-"));
  const build = start("node", ["--disable-warning=ExperimentalWarning", "src/build.ts", out], {}, []);
  await waitFor("转换", () => build.exitCode !== null);
  check("转换成功", build.exitCode === 0);
  const log: string[] = [];
  const node = start("node", ["--max-semi-space-size=1", join(out, "runtime/node.js")], { BOT_TOKEN: TOKEN, DATA_DIR: dataDir, TELEGRAM_API_BASE: fake.url, NODE_NO_WARNINGS: "1" }, log);
  try {
    check("转好的 JS 能启动并连上", await waitFor("连接", () => log.join("").includes("已连接")), log.join(""));
    const code = /claim_([\w-]+)/.exec(log.join(""))?.[1];
    await waitFor("链接", () => /claim_/.test(log.join("")));
    fake.queue.push(textUpdate(OWNER, `/start claim_${code ?? /claim_([\w-]+)/.exec(log.join(""))?.[1] ?? ""}`, 31));
    check("转好的 JS 能处理消息", await waitFor("绑定", () => fake.named("sendMessage").some((m) => String(m.text).includes("绑定成功"))));
  } finally {
    node.kill("SIGKILL");
    rmSync(out, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const fake = await startFakeTelegram(TOKEN);
await testNode(fake);
await testBuilt(fake);
await testWeb(fake);
await fake.close();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
