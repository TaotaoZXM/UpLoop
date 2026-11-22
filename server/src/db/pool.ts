import pg from "pg";
import { env } from "../env.js";

export type SqlParam =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | undefined
  | Uint8Array
  | Record<string, unknown>
  | unknown[];

export type QueryResult<T> = { rows: T[]; rowCount: number };

/** Every repository depends only on this interface, so tests can inject a fake. */
export interface Executor {
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<QueryResult<T>>;
}

export interface Db extends Executor {
  one<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  rows<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  tx<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/**
 * WP1.2 / §6.1 high-risk point: MySQL DATETIME(3) is millisecond precision while
 * PostgreSQL timestamptz is microsecond. Every value that crosses the optimistic
 * lock boundary is truncated to milliseconds here.
 */
export function isoTimestamp(value: unknown): string | null {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString() : String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  if (match[4]) {
    const parsed = new Date(text.includes(" ") ? text.replace(" ", "T") : text);
    if (Number.isNaN(parsed.getTime())) return null;
    return truncateMillis(parsed.toISOString());
  }
  const fraction = (match[3] || ".000").padEnd(4, "0").slice(0, 4);
  return `${match[1]}T${match[2]}${fraction}Z`;
}

function truncateMillis(iso: string) {
  return iso.replace(/(\.\d{3})\d*Z$/, "$1Z");
}

/** Application-generated timestamps keep DB writes aligned with isoTimestamp(). */
export function nowMsIso(at: Date = new Date()) {
  return truncateMillis(at.toISOString());
}

/** Always pass JSON as a string with an explicit ::jsonb cast in SQL. */
export function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

export function readJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function executorFrom(client: pg.Pool | pg.PoolClient): Executor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
      const result = await client.query(sql, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
  };
}

export function createDb(databaseUrl = env.databaseUrl): Db {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const base = executorFrom(pool);
  return {
    ...base,
    async one<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []) {
      const result = await base.query<T>(sql, params);
      return result.rows[0];
    },
    async rows<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []) {
      const result = await base.query<T>(sql, params);
      return result.rows;
    },
    async tx<T>(fn: (tx: Executor) => Promise<T>) {
      const client = await pool.connect();
      const scoped = executorFrom(client);
      try {
        await client.query("BEGIN");
        const value = await fn(scoped);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async end() {
      await pool.end();
    },
  };
}

/**
 * Test double. `impl` receives the SQL and its parameters and returns rows.
 * tx() shares the same executor; no real transaction isolation is needed for unit tests.
 */
export function createFakeDb(
  impl: (sql: string, params: SqlParam[]) => QueryResult<Record<string, unknown>> | Promise<QueryResult<Record<string, unknown>>>,
): Db {
  const executor: Executor = {
    async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []) {
      const result = await impl(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },
  };
  return {
    ...executor,
    async one<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []) {
      return (await executor.query<T>(sql, params)).rows[0];
    },
    async rows<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []) {
      return (await executor.query<T>(sql, params)).rows;
    },
    async tx<T>(fn: (tx: Executor) => Promise<T>) {
      return fn(executor);
    },
    async end() {},
  };
}
