/**
 * WP3.2: fact-event projection (§6.5). Idempotent via UNIQUE(user_id, ref_table, ref_id).
 * 002_memory.sql is optional in P1 (it needs ltree), so projection is gated by a
 * startup capability check instead of failing every write when the table is absent.
 */
import { json, nowMsIso, type Db, type Executor } from "../db/pool.js";
import { todayShanghai } from "../wellness/logic/time.js";

let memoryEnabled = false;

export function setMemoryEnabled(value: boolean) {
  memoryEnabled = value;
}

export function isMemoryEnabled() {
  return memoryEnabled;
}

export async function detectMemoryTables(db: Db) {
  try {
    const row = await db.one<{ present: boolean }>(
      "SELECT to_regclass('public.life_events') IS NOT NULL AS present",
    );
    setMemoryEnabled(Boolean(row?.present));
  } catch {
    setMemoryEnabled(false);
  }
  return isMemoryEnabled();
}

export type LifeEventInput = {
  userId: string;
  type: string;
  day?: string;
  refTable: string;
  refId: string;
  payload: unknown;
  isSensitive?: boolean;
  occurredAt?: string;
};

/** Call inside the same transaction as the source write. */
export async function projectLifeEvent(db: Executor, input: LifeEventInput) {
  if (!memoryEnabled) return false;
  const day = input.day || todayShanghai();
  const result = await db.query(
    `INSERT INTO life_events (user_id, type, day, occurred_at, ref_table, ref_id, payload, is_sensitive)
     VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7::jsonb,$8)
     ON CONFLICT (user_id, ref_table, ref_id) DO NOTHING`,
    [
      input.userId, input.type, day, input.occurredAt || nowMsIso(),
      input.refTable, input.refId, json(input.payload), Boolean(input.isSensitive),
    ],
  );
  if (result.rowCount) await markDayDirty(db, input.userId, day);
  return result.rowCount > 0;
}

/** Editing a historical record invalidates that day's node; the nightly job recomputes it. */
export async function markDayDirty(db: Executor, userId: string, day: string) {
  if (!memoryEnabled) return;
  await db.query(
    "UPDATE memory_nodes SET dirty = true WHERE user_id = $1 AND level = 'day' AND period_start = $2",
    [userId, day],
  );
}
