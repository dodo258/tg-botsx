import type { Db, Row, SqlValue, Statement } from "../core/db.ts";

class D1Stmt implements Statement {
  readonly raw: D1PreparedStatement;
  constructor(raw: D1PreparedStatement) {
    this.raw = raw;
  }
  bind(...values: SqlValue[]): Statement {
    return new D1Stmt(this.raw.bind(...values));
  }
  async first<T = Row>(): Promise<T | null> {
    return await this.raw.first<T>();
  }
  async all<T = Row>(): Promise<T[]> {
    const result = await this.raw.all<T>();
    return result.results;
  }
  async run(): Promise<number> {
    const result = await this.raw.run();
    return result.meta.changes;
  }
}

export function d1Db(database: D1Database): Db {
  return {
    prepare: (sql) => new D1Stmt(database.prepare(sql)),
    async batch(statements) {
      const raws: D1PreparedStatement[] = [];
      for (const statement of statements) {
        if (!(statement instanceof D1Stmt)) throw new Error("批量执行收到了非 D1 语句");
        raws.push(statement.raw);
      }
      if (raws.length > 0) await database.batch(raws);
    },
    async execScript(sql) {
      // D1 的 exec 按行切语句，这里手动拆开后走 batch，保证同一事务。
      const parts = sql.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
      await database.batch(parts.map((part) => database.prepare(part)));
    },
  };
}
