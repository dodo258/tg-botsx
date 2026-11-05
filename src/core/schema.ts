// 迁移按版本号顺序执行，只增不改。时间一律存 Unix 秒，显示时再按设置的时区换算。
import type { Db } from "./db.ts";
import { num } from "./db.ts";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE contacts(
    user_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    language_code TEXT NOT NULL DEFAULT '',
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    touches INTEGER NOT NULL DEFAULT 1,
    last_inbound_at INTEGER,
    last_card_at INTEGER,
    last_card_msg_id INTEGER,
    unread INTEGER NOT NULL DEFAULT 0,
    first_unread_at INTEGER,
    msg_count INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    blocked_at INTEGER,
    block_reason TEXT NOT NULL DEFAULT '',
    unreachable_at INTEGER,
    thread_id INTEGER,
    thread_claim_at INTEGER,
    verified_at INTEGER,
    verify_exempt INTEGER NOT NULL DEFAULT 0,
    approved_at INTEGER,
    challenge_id TEXT,
    challenge_token TEXT,
    challenge_at INTEGER,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    rate_window INTEGER NOT NULL DEFAULT 0,
    rate_count INTEGER NOT NULL DEFAULT 0,
    muted_until INTEGER,
    last_receipt_at INTEGER,
    last_offline_at INTEGER
  );
  CREATE INDEX idx_contacts_recent ON contacts(last_seen DESC);
  CREATE INDEX idx_contacts_first_seen ON contacts(first_seen);
  CREATE INDEX idx_contacts_thread ON contacts(thread_id);

  CREATE TABLE messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')),
    kind TEXT NOT NULL,
    text TEXT,
    file_id TEXT,
    user_msg_id INTEGER,
    desk_chat_id INTEGER,
    desk_msg_id INTEGER,
    staff_id INTEGER,
    status TEXT NOT NULL DEFAULT 'sent',
    reason TEXT,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    retracted_at INTEGER
  );
  CREATE INDEX idx_messages_user ON messages(user_id, id DESC);
  CREATE INDEX idx_messages_desk ON messages(desk_chat_id, desk_msg_id);
  CREATE INDEX idx_messages_user_msg ON messages(user_id, user_msg_id);
  CREATE INDEX idx_messages_created ON messages(created_at);
  CREATE INDEX idx_messages_status ON messages(status, id DESC);

  CREATE TABLE cards(
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(chat_id, message_id)
  );

  CREATE TABLE seen_updates(update_id INTEGER PRIMARY KEY, seen_at INTEGER NOT NULL);
  CREATE INDEX idx_seen_at ON seen_updates(seen_at);

  CREATE TABLE album_buffer(
    group_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    from_chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    staff_id INTEGER,
    thread_id INTEGER,
    kind TEXT NOT NULL,
    text TEXT,
    file_id TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY(group_id, message_id)
  );

  CREATE TABLE held_messages(
    user_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    file_id TEXT,
    reason TEXT,
    held_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, message_id)
  );

  CREATE TABLE quick_replies(name TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL);

  CREATE TABLE auto_rules(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keywords TEXT NOT NULL,
    reply TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE broadcasts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_chat_id INTEGER NOT NULL,
    from_msg_id INTEGER NOT NULL,
    report_chat_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',
    cursor INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX idx_broadcasts_state ON broadcasts(state);

  CREATE TABLE daily_stats(
    day TEXT PRIMARY KEY,
    inbound INTEGER NOT NULL DEFAULT 0,
    outbound INTEGER NOT NULL DEFAULT 0,
    new_contacts INTEGER NOT NULL DEFAULT 0,
    filtered INTEGER NOT NULL DEFAULT 0,
    reply_seconds INTEGER NOT NULL DEFAULT 0,
    replies INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE staff_state(
    staff_id INTEGER PRIMARY KEY,
    selected_user_id INTEGER,
    awaiting TEXT,
    awaiting_at INTEGER
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** 建表或补迁移。同一个 Worker 实例只查一次，不给每条消息增加查询。 */
export async function migrate(db: Db): Promise<void> {
  await db.execScript("CREATE TABLE IF NOT EXISTS schema_meta(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
  const row = await db.prepare("SELECT version FROM schema_meta WHERE id = 1").first<{ version: unknown }>();
  const current = row ? num(row.version) : 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const script = MIGRATIONS[version];
    if (script === undefined) continue;
    await db.execScript(script);
    await db
      .prepare("INSERT INTO schema_meta(id, version) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version")
      .bind(version + 1)
      .run();
  }
}
