/**
 * WP3.2: nightly day-summary rebuild via a systemd timer (never setInterval in
 * the Express process). The model only receives aggregate stats plus a bounded
 * number of non-sensitive titles; raw conversation text is never sent, and
 * is_sensitive events are stored but excluded from any prompt.
 */
import { json, type Db } from "../db/pool.js";
import { computeReportStats } from "../report/routes.js";
import { addDays, todayShanghai } from "../wellness/logic/time.js";
import { isMemoryEnabled } from "./projection.js";

export const MAX_TITLES_FOR_MODEL = 8;

export function ltreePath(day: string) {
  const [year, month, date] = day.split("-");
  const week = Math.ceil((Number(month) * 30 + Number(date)) / 7);
  return `y${year}.w${Math.min(53, Math.max(1, week))}.d${year}${month}${date}`;
}

export function templateSummary(stats: Awaited<ReturnType<typeof computeReportStats>>) {
  if (stats.isEmpty) return "这一天没有留下记录。";
  const parts = [`${stats.day}：完成 ${stats.doneCount} 件事`];
  if (stats.focusMinutes) parts.push(`专注 ${stats.focusMinutes} 分钟`);
  if (stats.entryCount) parts.push(`记了 ${stats.entryCount} 条健康记录`);
  if (stats.routineDoneCount) parts.push(`Routine 完成 ${stats.routineDoneCount} 项`);
  return `${parts.join("，")}。`;
}

/** Only non-sensitive, short titles; never full text. */
export async function nonSensitiveTitles(db: Db, userId: string, day: string) {
  const rows = await db.rows<{ payload: unknown }>(
    `SELECT payload FROM life_events
     WHERE user_id = $1 AND day = $2 AND is_sensitive = false
     ORDER BY occurred_at DESC LIMIT $3`,
    [userId, day, MAX_TITLES_FOR_MODEL],
  );
  return rows
    .map((row) => {
      const payload = row.payload as { title?: string; kind?: string } | null;
      return String(payload?.title || payload?.kind || "").slice(0, 40);
    })
    .filter(Boolean);
}

export async function ensureDayNode(db: Db, userId: string, day: string) {
  if (!isMemoryEnabled()) return false;
  const stats = await computeReportStats(db, userId, day);
  await nonSensitiveTitles(db, userId, day);
  const summary = templateSummary(stats);
  await db.query(
    `INSERT INTO memory_nodes (user_id, level, period_start, period_end, path, stats, summary, dirty, version)
     VALUES ($1,'day',$2,$2,$3::ltree,$4::jsonb,$5,false,1)
     ON CONFLICT (user_id, level, period_start) DO UPDATE SET
       stats = EXCLUDED.stats, summary = EXCLUDED.summary, dirty = false,
       version = memory_nodes.version + 1`,
    [userId, day, ltreePath(day), json(stats), summary],
  );
  return true;
}

/** Editing a historical record marks a node dirty; the nightly job recomputes it. */
export async function recomputeDirtyDays(db: Db) {
  if (!isMemoryEnabled()) return 0;
  const dirty = await db.rows<{ user_id: string; period_start: string }>(
    "SELECT user_id, period_start FROM memory_nodes WHERE level = 'day' AND dirty = true",
  );
  for (const node of dirty) {
    await ensureDayNode(db, node.user_id, String(node.period_start).slice(0, 10));
  }
  return dirty.length;
}

export async function nightlyRun(db: Db, days = 2) {
  if (!isMemoryEnabled()) return { enabled: false, rebuilt: 0, created: 0 };
  const users = await db.rows<{ id: string }>("SELECT id FROM users");
  const today = todayShanghai();
  let created = 0;
  for (let offset = 0; offset < days; offset += 1) {
    const day = addDays(today, -offset);
    for (const user of users) {
      await ensureDayNode(db, user.id, day);
      created += 1;
    }
  }
  const rebuilt = await recomputeDirtyDays(db);
  return { enabled: true, rebuilt, created };
}
