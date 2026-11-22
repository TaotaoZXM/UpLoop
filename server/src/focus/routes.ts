/**
 * WP2.9 / HW-F3: the server is the time source. Only started_at / elapsed_sec /
 * status are stored; clients calibrate their countdown against `serverNow`.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { asyncRoute } from "../http.js";
import { authUser } from "../auth/session.js";
import { HttpError } from "../errors.js";
import { nowMsIso, type Db } from "../db/pool.js";
import { projectLifeEvent } from "../memory/projection.js";
import type { AppDeps } from "../types.js";

type FocusRow = {
  id: string;
  user_id: string;
  task_ref: string | null;
  planned_sec: number;
  started_at: string;
  ended_at: string | null;
  status: "running" | "paused" | "done" | "abandoned";
  elapsed_sec: number;
  source: string;
};

function elapsedSince(startedAt: string, now = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
}

function view(row: FocusRow, serverNow = nowMsIso()) {
  const running = row.status === "running";
  const elapsed = Number(row.elapsed_sec || 0) + (running ? elapsedSince(row.started_at, new Date(serverNow).getTime()) : 0);
  return {
    id: row.id,
    taskRef: row.task_ref,
    plannedSec: Number(row.planned_sec),
    status: row.status,
    elapsedSec: elapsed,
    remainingSec: Math.max(0, Number(row.planned_sec) - elapsed),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    source: row.source,
    serverNow,
  };
}

export async function startFocus(db: Db, userId: string, plannedSec: number, taskRef?: string | null, source = "web") {
  const seconds = Math.round(Number(plannedSec));
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 14400) {
    throw new HttpError(400, "planned_sec", "专注时长请设 1 分钟到 4 小时");
  }
  const existing = await db.one<FocusRow>(
    "SELECT * FROM focus_sessions WHERE user_id = $1 AND status IN ('running','paused') ORDER BY started_at DESC LIMIT 1",
    [userId],
  );
  if (existing) return view(existing);
  const id = randomUUID();
  const at = nowMsIso();
  await db.query(
    `INSERT INTO focus_sessions (id, user_id, task_ref, planned_sec, started_at, status, elapsed_sec, source)
     VALUES ($1,$2,$3,$4,$5::timestamptz,'running',0,$6)`,
    [id, userId, taskRef || null, seconds, at, source],
  );
  return view({ id, user_id: userId, task_ref: taskRef || null, planned_sec: seconds, started_at: at, ended_at: null, status: "running", elapsed_sec: 0, source }, at);
}

async function transition(db: Db, userId: string, id: string, action: "pause" | "resume" | "finish" | "abandon") {
  const row = await db.one<FocusRow>("SELECT * FROM focus_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!row) throw new HttpError(404, "not_found", "没有这次专注");
  const now = nowMsIso();
  let elapsed = Number(row.elapsed_sec || 0);
  if (row.status === "running") elapsed += elapsedSince(row.started_at, new Date(now).getTime());
  const terminal = action === "finish" || action === "abandon";
  const status = action === "pause" ? "paused" : action === "resume" || action === "finish" ? (action === "finish" ? "done" : "running") : "abandoned";
  await db.query(
    `UPDATE focus_sessions SET status = $2, elapsed_sec = $3,
        started_at = CASE WHEN $2 = 'running' THEN $4::timestamptz ELSE started_at END,
        ended_at = CASE WHEN $5::boolean THEN $4::timestamptz ELSE ended_at END
     WHERE id = $1`,
    [id, status, elapsed, now, terminal],
  );
  if (terminal) {
    await projectLifeEvent(db, {
      userId, type: "focus", day: now.slice(0, 10), refTable: "focus_sessions", refId: id,
      payload: { elapsedSec: elapsed, status },
      occurredAt: now,
    });
  }
  return view({ ...row, status: status as FocusRow["status"], elapsed_sec: elapsed, started_at: status === "running" ? now : row.started_at, ended_at: terminal ? now : null }, now);
}

export function createFocusRouter({ db }: AppDeps) {
  const router = Router();

  router.post(
    "/focus",
    asyncRoute(async (req, res) => {
      const body = (req.body || {}) as { planned_sec?: number; plannedSec?: number; minutes?: number; task_ref?: string; source?: string };
      const planned = body.planned_sec ?? body.plannedSec ?? (body.minutes ? Number(body.minutes) * 60 : 25 * 60);
      const session = await startFocus(db, authUser(req).id, Number(planned), body.task_ref, body.source || "web");
      return res.status(201).json({ session });
    }),
  );

  for (const action of ["pause", "resume", "finish", "abandon"] as const) {
    router.post(
      `/focus/:id/${action}`,
      asyncRoute(async (req, res) => {
        return res.json({ session: await transition(db, authUser(req).id, req.params.id, action) });
      }),
    );
  }

  router.get(
    "/focus/current",
    asyncRoute(async (req, res) => {
      const row = await db.one<FocusRow>(
        "SELECT * FROM focus_sessions WHERE user_id = $1 AND status IN ('running','paused') ORDER BY started_at DESC LIMIT 1",
        [authUser(req).id],
      );
      const serverNow = nowMsIso();
      return res.json({ session: row ? view(row, serverNow) : null, serverNow });
    }),
  );

  return router;
}
