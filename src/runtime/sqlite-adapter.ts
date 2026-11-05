import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Db, Row, SqlValue, Statement } from "../core/db.ts";

class SqliteStmt implements Statement {
  private readonly stmt: StatementSync;
  private readonly values: SqlValue[];
  constructor(stmt: StatementSync, values: SqlValue[] = []) {
    this.stmt = stmt;
    this.values = values;
  }
  bind(...values: SqlValue[]): Statement {
    return new SqliteStmt(this.stmt, values);
  }
  async first<T = Row>(): Promise<T | null> {
    const row: unknown = this.stmt.get(...this.values);
    return row === undefined ? null : narrow<T>(row);
  }
  async all<T = Row>(): Promise<T[]> {
    return this.stmt.all(...this.values).map((row) => narrow<T>(row));
  }
  async run(): Promise<number> {
    return Number(this.stmt.run(...this.values).changes);
  }
  runSync(): void {
    this.stmt.run(...this.values);
  }
}

// node:sqlite 按列返回普通对象，字段形状由 SQL 决定，和 D1 的泛型 first<T> 一样由调用方负责。
function narrow<T>(row: unknown): T {
  return row as T;
}

export function sqliteDb(path: string): Db & { close(): void; vacuumInto(target: string): void } {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  return {
    prepare: (sql) => new SqliteStmt(database.prepare(sql)),
    async batch(statements) {
      database.exec("BEGIN");
      try {
        for (const statement of statements) {
          if (!(statement instanceof SqliteStmt)) throw new Error("批量执行收到了非 SQLite 语句");
          statement.runSync();
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async execScript(sql) {
      database.exec(sql);
    },
    close: () => database.close(),
    vacuumInto: (target) => database.prepare("VACUUM INTO ?").run(target),
  };
}
