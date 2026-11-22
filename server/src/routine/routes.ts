/**
 * WP1.4 / M05-F2: routines + per-day checks. The old `done` boolean had no date,
 * so migration deliberately starts every routine unchecked (§7 WP1.4 step 3).
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { asyncRoute, dayOf, isYmd } from "../http.js";
import { authUser } from "../auth/session.js";
import { HttpError } from "../errors.js";
import type { Db } from "../db/pool.js";
import type { AppDeps } from "../types.js";

/** A routine is a daily checklist in the same shape as a task plan: ordered steps with time and stage. */
const MAX_STEPS = 60;
const SCENARIOS = new Set(["life", "work"]);
export type RoutineStep = { title: string; minutes: number; stage: string };

function cleanScenario(value: unknown) {
  const scenario = String(value || "life");
  if (!SCENARIOS.has(scenario)) throw new HttpError(400, "scenario", "场景请选择生活或工作");
  return scenario;
}

/** Accepts legacy strings ("step1 洗脸") and step objects; strips the old "stepN" prefix. */
function stepOf(raw: unknown): RoutineStep | null {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : { title: raw };
  const title = String(source.title ?? "").replace(/^\s*step\s*\d+[\s.:：、-]*/i, "").trim().slice(0, 30);
  if (!title) return null;
  const minutes = Number(source.minutes);
  return { title, minutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 240 ? minutes : 10, stage: String(source.stage ?? "").trim().slice(0, 40) };
}
function cleanSteps(input: unknown): RoutineStep[] {
  if (!Array.isArray(input)) return [];
  return input.map(stepOf).filter((step): step is RoutineStep => Boolean(step)).slice(0, MAX_STEPS);
}
const stepsOf = (value: unknown) => cleanSteps(value);

export async function createRoutine(db: Db, userId: string, title: string, steps: unknown[] = [], scenarioValue: unknown = "life") {
  const clean = String(title || "").trim().slice(0, 80);
  if (!clean) throw new HttpError(400, "title", "请写一项 Routine");
  const orderedSteps = cleanSteps(steps);
  const scenario = cleanScenario(scenarioValue);
  const row = await db.one<{ max_order: number | null }>(
    "SELECT MAX(sort_order) AS max_order FROM routines WHERE user_id = $1",
    [userId],
  );
  const id = randomUUID();
  await db.query(
    "INSERT INTO routines (id, user_id, title, steps, sort_order, scenario) VALUES ($1,$2,$3,$4::jsonb,$5,$6)",
    [id, userId, clean, JSON.stringify(orderedSteps), Number(row?.max_order || 0) + 1, scenario],
  );
  return { id, title: clean, steps: orderedSteps, scenario };
}

export async function checkRoutine(db: Db, userId: string, routineId: string, day: string, checked: boolean) {
  const owned = await db.one<{ id: string }>(
    "SELECT id FROM routines WHERE id = $1 AND user_id = $2",
    [routineId, userId],
  );
  if (!owned) throw new HttpError(404, "not_found", "没有这一项 Routine");
  if (checked) {
    await db.query(
      `INSERT INTO routine_checks (routine_id, day, checked_at) VALUES ($1,$2,now())
       ON CONFLICT (routine_id, day) DO NOTHING`,
      [routineId, day],
    );
  } else {
    await db.query("DELETE FROM routine_checks WHERE routine_id = $1 AND day = $2", [routineId, day]);
  }
  return { id: routineId, day, checked };
}

/** Used by the chat router for "护肤完成了" style sentences. */
export async function findRoutineByTitle(db: Db, userId: string, title: string) {
  const keyword = String(title || "").trim().slice(0, 20);
  if (!keyword) return null;
  const row = await db.one<{ id: string; title: string }>(
    "SELECT id, title FROM routines WHERE user_id = $1 AND title ILIKE $2 AND archived_at IS NULL LIMIT 1",
    [userId, `%${keyword}%`],
  );
  return row || null;
}

export function createRoutineRouter({ db }: AppDeps) {
  const router = Router();

  router.get(
    "/routines",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const day = dayOf(req.query.day);
      const rows = await db.rows<{ id: string; title: string; steps: unknown; scenario: string; created_at: string; sort_order: number; checked: boolean }>(
        `SELECT r.id, r.title, r.steps, r.scenario, r.created_at, r.sort_order,
                EXISTS (SELECT 1 FROM routine_checks c WHERE c.routine_id = r.id AND c.day = $2) AS checked
         FROM routines r WHERE r.user_id = $1 AND r.archived_at IS NULL
         ORDER BY r.sort_order ASC, r.created_at ASC`,
        [user.id, day],
      );
      return res.json({
        day,
        items: rows.map((row) => ({
          id: row.id, title: row.title, steps: stepsOf(row.steps), scenario: SCENARIOS.has(row.scenario) ? row.scenario : "life", createdAt: row.created_at, checked: Boolean(row.checked),
        })),
        doneCount: rows.filter((row) => Boolean(row.checked)).length,
      });
    }),
  );

  router.post(
    "/routines",
    asyncRoute(async (req, res) => {
      const item = await createRoutine(
        db, authUser(req).id, String(req.body?.title || ""), cleanSteps(req.body?.steps), req.body?.scenario,
      );
      return res.status(201).json({ item });
    }),
  );

  router.put(
    "/routines/:id",
    asyncRoute(async (req, res) => {
      const title = String(req.body?.title || "").trim().slice(0, 80);
      if (!title) throw new HttpError(400, "title", "请写清单名称");
      const steps = cleanSteps(req.body?.steps);
      const scenario = cleanScenario(req.body?.scenario);
      const result = await db.query(
        "UPDATE routines SET title = $3, steps = $4::jsonb, scenario = $5 WHERE id = $1 AND user_id = $2 AND archived_at IS NULL",
        [req.params.id, authUser(req).id, title, JSON.stringify(steps), scenario],
      );
      if (!result.rowCount) throw new HttpError(404, "not_found", "没有这份清单");
      return res.json({ item: { id: req.params.id, title, steps, scenario } });
    }),
  );

  router.get("/routines/timeline", asyncRoute(async (req, res) => {
    const userId = authUser(req).id;
    const from = String(req.query.from || ""), to = String(req.query.to || "");
    if (!isYmd(from) || !isYmd(to) || from > to || Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`) > 90 * 86400000) {
      throw new HttpError(400, "timeline_range", "时间范围最多选择 90 天");
    }
    const rows = await db.rows<{ id: string; title: string; scenario: string; day: string }>(
      `SELECT r.id, r.title, r.scenario, c.day::text AS day FROM routine_checks c
       JOIN routines r ON r.id = c.routine_id WHERE r.user_id = $1
       AND c.day BETWEEN $2 AND $3 ORDER BY c.day ASC, c.checked_at ASC`, [userId, from, to]);
    const previous = await db.one<{ day: string | null }>(
      `SELECT MAX(c.day)::text AS day FROM routine_checks c JOIN routines r ON r.id = c.routine_id
       WHERE r.user_id = $1 AND c.day < $2`, [userId, from]);
    return res.json({ previousDay: previous?.day || null, events: rows.map(row => ({ id: row.id, title: row.title, scenario: SCENARIOS.has(row.scenario) ? row.scenario : "life", day: String(row.day).slice(0, 10) })) });
  }));

  router.put(
    "/routines/:id/check",
    asyncRoute(async (req, res) => {
      const day = dayOf(req.body?.day);
      if (!isYmd(day)) throw new HttpError(400, "day", "日期不对");
      const result = await checkRoutine(
        db, authUser(req).id, req.params.id, day, req.body?.checked !== false,
      );
      return res.json(result);
    }),
  );

  router.delete(
    "/routines/:id",
    asyncRoute(async (req, res) => {
      const result = await db.query(
        "UPDATE routines SET archived_at = now() WHERE id = $1 AND user_id = $2 AND archived_at IS NULL",
        [req.params.id, authUser(req).id],
      );
      if (!result.rowCount) throw new HttpError(404, "not_found", "没有这一项 Routine");
      return res.json({ ok: true });
    }),
  );

  return router;
}
