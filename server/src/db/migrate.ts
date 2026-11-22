import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./pool.js";
import { env } from "../env.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * WP1.2: replace db.js's semicolon-splitting migrator with ordered files plus
 * schema_migrations bookkeeping. Each file runs as one simple query (multi-statement
 * is allowed when no bind parameters are used).
 */
export async function migrate(db: Db, maxVersion = env.migrateMax) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await db.rows<{ version: string }>("SELECT version FROM schema_migrations")).map((r) => r.version));
  // A cap selects a numbered release, including compatibility migrations in it.
  // Accept both "001" and the legacy full name "001_init".
  const cap = /^(\d+)(?:_[a-z0-9_]+)?$/i.exec(maxVersion);
  if (!cap) throw new Error(`Invalid migration version: ${maxVersion}`);
  const maxNumber = Number(cap[1]);
  let count = 0;
  for (const file of migrationFiles()) {
    const version = file.replace(/\.sql$/, "");
    const number = /^(\d+)_/.exec(version);
    if (!number) throw new Error(`Invalid migration filename: ${file}`);
    if (Number(number[1]) > maxNumber) continue;
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await db.tx(async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
    });
    applied.add(version);
    count += 1;
  }
  return count;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const db = createDb();
  try {
    const count = await migrate(db);
    console.log(`[task] migrations applied: ${count}`);
  } finally {
    await db.end();
  }
}
