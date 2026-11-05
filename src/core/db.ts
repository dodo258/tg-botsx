// 数据库接口。业务代码只认这个接口，不直接依赖 node:sqlite。

export type Row = Record<string, unknown>;

export interface Statement {
  bind(...values: SqlValue[]): Statement;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<T[]>;
  /** 返回受影响的行数 */
  run(): Promise<number>;
}

export type SqlValue = string | number | null;

export interface Db {
  prepare(sql: string): Statement;
  /** 一次事务里执行多条语句。 */
  batch(statements: Statement[]): Promise<void>;
  /** 执行含多条语句的 SQL，只用于建表迁移。 */
  execScript(sql: string): Promise<void>;
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
