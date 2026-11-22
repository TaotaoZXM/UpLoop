/**
 * WP1.2 / WP1.4: one-time MySQL -> PostgreSQL data migration.
 *   - qingzhou users are live: id, password_hash, token_version, email_verified_at,
 *     role are preserved verbatim so existing sessions stay valid.
 *   - state JSON is copied as-is to jsonb (optimistic-lock value is regenerated
 *     in millisecond precision by the new server).
 *   - legacy state.expenses / state.routines are split into their new tables;
 *     old routine `done:true` is NOT treated as "checked today" (no date existed).
 *   - repeatable: ON CONFLICT DO NOTHING everywhere.
 * Run `npm run migrate:mysql -- --dry-run` first, then without the flag.
 * Production: back up RDS MySQL, rehearse >= 2 times on a masked copy (§11).
 */
import { createHash, randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import pg from "pg";
import { todayShanghai } from "../src/wellness/logic/time.js";

type LegacyExpense = { id?: string; amount?: string; note?: string; createdAt?: string };
type LegacyRoutine = { id?: string; title?: string; done?: boolean; createdAt?: string };
type LegacyState = {
  version?: number;
  todo?: unknown[];
  done?: unknown[];
  ideas?: unknown[];
  feedback?: unknown[];
  projects?: unknown[];
  expenses?: LegacyExpense[];
  routines?: LegacyRoutine[];
  updatedAt?: string;
};

/** Deterministic hash so jsonb key reordering does not create false mismatches. */
export function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        sorted[key] = normalize((input as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

/** WP1.4: strip the two split fields; the new server ignores them anyway. */
export function convertState(raw: unknown) {
  const state: LegacyState = typeof raw === "string" ? JSON.parse(raw) : { ...(raw as LegacyState) };
  const expenses = Array.isArray(state.expenses) ? state.expenses : [];
  const routines = Array.isArray(state.routines) ? state.routines : [];
  const { expenses: _dropExpenses, routines: _dropRoutines, ...clean } = state;
  return { clean: { ...clean, version: clean.version || 1 }, expenses, routines };
}

export function expenseFromLegacy(item: LegacyExpense, userId: string) {
  const amount = Number(String(item.amount || "").trim());
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const amountCents = Math.round(amount * 100);
  if (amountCents <= 0) return null;
  const spentAt = item.createdAt && !Number.isNaN(new Date(item.createdAt).getTime())
    ? new Date(item.createdAt).toISOString()
    : new Date().toISOString();
  return {
    id: randomUUID(),
    userId,
    amountCents,
    note: String(item.note || "").slice(0, 120),
    category: null,
    spentAt,
    day: todayShanghai(new Date(spentAt)),
    source: "migrated",
  };
}

export function routineFromLegacy(item: LegacyRoutine, userId: string, sortOrder: number) {
  const title = String(item.title || "").trim().slice(0, 80);
  if (!title) return null;
  return { id: randomUUID(), userId, title, sortOrder };
}

function mysqlTimestamp(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim().replace(" ", "T");
  const iso = /[Z+-]\d{2}:?\d{2}$|[Z]$/.test(text) ? text : `${text}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export type MigrationReport = {
  users: number;
  states: number;
  expenses: number;
  routines: number;
  resetTokens: number;
  verifyTokens: number;
  mismatches: string[];
  adminFound: boolean;
};

export async function runMigration(options: { dryRun?: boolean } = {}): Promise<MigrationReport> {
  const mysqlUrl = process.env.MYSQL_DATABASE_URL || "";
  const pgUrl = process.env.DATABASE_URL || "";
  if (!mysqlUrl || !pgUrl) throw new Error("MYSQL_DATABASE_URL and DATABASE_URL are required");

  const source = await mysql.createConnection(mysqlUrl);
  const target = new pg.Pool({ connectionString: pgUrl, max: 4 });
  const client = await target.connect();
  const report: MigrationReport = {
    users: 0, states: 0, expenses: 0, routines: 0,
    resetTokens: 0, verifyTokens: 0, mismatches: [], adminFound: false,
  };
  try {
    const [userRows] = await source.execute(
      "SELECT id, email, password_hash, username, email_verified_at, token_version, role, created_at FROM users",
    );
    const users = userRows as Array<Record<string, unknown>>;
    const [stateRows] = await source.execute("SELECT user_id, state, updated_at FROM user_app_state");
    const states = stateRows as Array<Record<string, unknown>>;
    const [resetRows] = await source.execute("SELECT * FROM password_reset_tokens");
    const [verifyRows] = await source.execute("SELECT * FROM email_verification_tokens");

    if (!options.dryRun) await client.query("BEGIN");
    for (const user of users) {
      if (!options.dryRun) {
        await client.query(
          `INSERT INTO users (id, email, password_hash, username, email_verified_at, token_version, role, created_at)
           VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [
            user.id, user.email, user.password_hash, user.username || null,
            mysqlTimestamp(user.email_verified_at), Number(user.token_version || 0),
            user.role || "user", mysqlTimestamp(user.created_at) || new Date().toISOString(),
          ],
        );
      }
      report.users += 1;
      if (user.role === "admin") report.adminFound = true;
    }
    for (const [table, rows, counter] of [
      ["password_reset_tokens", resetRows, "resetTokens"],
      ["email_verification_tokens", verifyRows, "verifyTokens"],
    ] as const) {
      for (const row of rows as Array<Record<string, unknown>>) {
        if (!options.dryRun) {
          await client.query(
            `INSERT INTO ${table} (id, user_id, token_hash, expires_at, used_at, created_at)
             VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::timestamptz)
             ON CONFLICT (id) DO NOTHING`,
            [
              row.id, row.user_id, row.token_hash, mysqlTimestamp(row.expires_at),
              mysqlTimestamp(row.used_at), mysqlTimestamp(row.created_at),
            ],
          );
        }
        report[counter] += 1;
      }
    }

    for (const row of states) {
      const userId = String(row.user_id);
      const { clean, expenses, routines } = convertState(row.state);
      if (!options.dryRun) {
        await client.query(
          `INSERT INTO user_app_state (user_id, state, updated_at) VALUES ($1,$2::jsonb,$3::timestamptz)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId, JSON.stringify(clean), mysqlTimestamp(row.updated_at) || new Date().toISOString()],
        );
        for (const legacy of expenses) {
          const expense = expenseFromLegacy(legacy, userId);
          if (!expense) continue;
          await client.query(
            `INSERT INTO expenses (id, user_id, amount_cents, note, category, spent_at, day, source)
             VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8)
             ON CONFLICT (id) DO NOTHING`,
            [expense.id, expense.userId, expense.amountCents, expense.note, expense.category, expense.spentAt, expense.day, expense.source],
          );
          report.expenses += 1;
        }
        let order = 0;
        for (const legacy of routines) {
          const routine = routineFromLegacy(legacy, userId, order);
          if (!routine) continue;
          order += 1;
          await client.query(
            "INSERT INTO routines (id, user_id, title, sort_order) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
            [routine.id, routine.userId, routine.title, routine.sortOrder],
          );
          report.routines += 1;
        }
      } else {
        report.expenses += expenses.length;
        report.routines += routines.length;
      }
      report.states += 1;
    }
    if (!options.dryRun) await client.query("COMMIT");

    // Reconciliation: row counts, per-user state hash, admin row.
    if (!options.dryRun) {
      const pgUsers = await client.query("SELECT COUNT(*)::int AS n FROM users");
      const pgStates = await client.query("SELECT COUNT(*)::int AS n FROM user_app_state");
      if (pgUsers.rows[0].n < report.users || pgStates.rows[0].n < report.states) {
        report.mismatches.push("row count: PostgreSQL has fewer rows than MySQL");
      }
      for (const row of states) {
        const userId = String(row.user_id);
        const { clean } = convertState(row.state);
        const pgRow = await client.query("SELECT state FROM user_app_state WHERE user_id = $1", [userId]);
        const stored = pgRow.rows[0]?.state ?? null;
        if (stableHash(stored) !== stableHash(clean)) {
          report.mismatches.push(`state hash mismatch for ${userId}`);
        }
      }
      const admin = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
      if (report.adminFound && admin.rows[0].n === 0) report.mismatches.push("admin row missing");
    }
    return report;
  } catch (error) {
    if (!options.dryRun) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await target.end();
    await source.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate-mysql-to-pg.ts")) {
  const dryRun = process.argv.includes("--dry-run");
  const report = await runMigration({ dryRun });
  console.log(JSON.stringify({ dryRun, ...report }, null, 2));
  if (report.mismatches.length) process.exitCode = 1;
}
