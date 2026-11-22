/**
 * Device endpoints for the small square screen's task card.
 * GET  /cards       -> open tasks + today's finished ones, each with its flower count
 * POST /cards/:id/progress -> one more flower (and a praise line)
 * POST /cards/:id/done     -> mark finished or reopen
 * The device token (taskr_) authenticates through the same requireUser chain as the web app.
 */
import { Router, type Request } from "express";
import { asyncRoute } from "../http.js";
import { authUser } from "../auth/session.js";
import { HttpError } from "../errors.js";
import { nowMsIso, readJson } from "../db/pool.js";
import { validateTaskLimits, usableState, type AppState } from "../state/routes.js";
import { todayShanghai } from "../wellness/logic/time.js";
import { praiseLine } from "./praise.js";
import type { AppDeps } from "../types.js";

type Item = Record<string, unknown> & { id: string; title?: string };

function uid(): string {
  const id = require("node:crypto").randomUUID();
  return `task_${id}`;
}

function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function readState(row: { state: unknown } | null | undefined): AppState {
  const state = row ? readJson<AppState | null>(row.state, null) : null;
  return usableState(state) ? state : { version: 1 };
}

const label = (scene: unknown) => (scene === "work" ? "工作" : "生活");
const priorityRank: Record<string, number> = { "urgent-important": 0, urgent: 1, important: 2, other: 3 };
const priorityLabel: Record<string, string> = { "urgent-important": "重要且紧急", urgent: "紧急", important: "重要", other: "其他" };

function deadlineText(raw: unknown) {
  if (typeof raw !== "string" || !raw) return "无截止时间";
  const date = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "无截止时间";
  const today = todayShanghai();
  const time = raw.length > 10 ? raw.slice(11, 16) : "";
  const body = time ? ` ${time} 截止` : " 截止";
  if (date === today) return `今天${body}`;
  const [, m, d] = date.split("-").map(Number);
  return `${m}月${d}日${body}`;
}

function sortCards(items: Item[]): Item[] {
  return items.slice().sort((a, b) => {
    const da = typeof a.deadline === "string" && a.deadline ? a.deadline : "￿";
    const db = typeof b.deadline === "string" && b.deadline ? b.deadline : "￿";
    return da < db ? -1 : da > db ? 1 : (priorityRank[String(a.priority)] || 3) - (priorityRank[String(b.priority)] || 3);
  });
}

function card(item: Item, flowers: number) {
  const done = Boolean(item.completed);
  const plan = (item.plan as { stages?: { steps?: { done?: boolean }[] }[] } | null) || null;
  const steps = (plan?.stages || []).flatMap(s => s.steps || []);
  return {
    id: item.id,
    title: String(item.title || ""),
    scene: label(item.scenario),
    priority: priorityLabel[String(item.priority)] || "其他",
    deadline: deadlineText(item.deadline),
    flowers,
    done,
    stepsDone: done ? steps.length : steps.filter(s => s.done).length,
    stepsTotal: steps.length,
  };
}

async function withState(db: AppDeps["db"], userId: string, mutate: (state: AppState) => AppState | null) {
  const writtenAt = nowMsIso();
  return db.tx(async tx => {
    const current = await tx.query<{ state: unknown }>("SELECT state FROM user_app_state WHERE user_id = $1 LIMIT 1 FOR UPDATE", [userId]);
    const state = readState(current.rows[0]);
    const next = mutate(state);
    if (!next) return null;
    const limit = validateTaskLimits(next);
    if (limit) throw new HttpError(400, "task_limit", limit);
    await tx.query(
      "INSERT INTO user_app_state (user_id, state, updated_at) VALUES ($1, $2::jsonb, $3::timestamptz) ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at",
      [userId, JSON.stringify(next), writtenAt],
    );
    return next;
  });
}

export function createDeviceCardsRouter({ db }: AppDeps) {
  const router = Router();

  router.get("/cards", asyncRoute(async (req, res) => {
    const userId = authUser(req).id;
    const row = await db.query<{ state: unknown }>("SELECT state FROM user_app_state WHERE user_id = $1 LIMIT 1", [userId]);
    const state = readState(row.rows[0]);
    const todo = (Array.isArray(state.todo) ? state.todo : []).filter(i => i && typeof (i as Item).id === "string") as Item[];
    const done = (Array.isArray(state.done) ? state.done : []).filter(i => i && typeof (i as Item).id === "string") as Item[];
    const flowers = await db.rows<{ task_id: string; count: number }>("SELECT task_id, count FROM task_flowers WHERE user_id = $1", [userId]);
    const byTask = new Map(flowers.map(f => [f.task_id, Number(f.count) || 0]));
    const open = sortCards(todo.filter(i => !i.repeatId && !i.completed));
    const finished = done.filter(i => !i.repeatId).slice(-3).map(i => ({ ...i, completed: true }));
    const cards = [...open, ...finished].slice(0, 12).map(i => card(i, byTask.get(i.id) || 0));
    return res.json({ cards, serverNow: nowMsIso() });
  }));

  router.post("/cards/:id/progress", asyncRoute(async (req, res) => {
    const userId = authUser(req).id;
    const taskId = String(req.params.id || "");
    if (!taskId || taskId.length > 120) throw new HttpError(400, "task_id", "任务标识无效");
    const flower = await db.query<{ count: number }>(
      `INSERT INTO task_flowers (user_id, task_id, count) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, task_id) DO UPDATE SET count = LEAST(task_flowers.count + 1, 99), updated_at = now()
       RETURNING count`,
      [userId, taskId],
    );
    const next = await withState(db, userId, state => {
      const todo = (Array.isArray(state.todo) ? state.todo : []) as Item[];
      const item = todo.find(i => i.id === taskId);
      if (!item) return state; // finished or removed: still record the flower
      const plan = item.plan as { stages?: { steps?: { done?: boolean }[] }[] } | null;
      const step = plan ? (plan.stages || []).flatMap(s => s.steps || []).find(s => !s.done) : null;
      if (step) step.done = true;
      return state;
    });
    const item = ((Array.isArray(next?.todo) ? next.todo : []) as Item[]).find(i => i.id === taskId);
    const praise = praiseLine({ type: "step", title: item?.title, hour: new Date().getHours() });
    return res.json({ flowers: Number(flower.rows[0]?.count) || 1, praise });
  }));

  router.post("/cards/:id/done", asyncRoute(async (req: Request, res) => {
    const userId = authUser(req).id;
    const taskId = String(req.params.id || "");
    const reopen = req.body?.reopen === true;
    if (!taskId || taskId.length > 120) throw new HttpError(400, "task_id", "任务标识无效");
    const moved = await withState(db, userId, state => {
      if (reopen) {
        const done = Array.isArray(state.done) ? state.done : [];
        const idx = done.findIndex(i => (i as Item).id === taskId);
        if (idx < 0) return null;
        const item = clean(done[idx]) as Item;
        delete item.completed;
        delete item.display;
        item.priority = item.priority || "other";
        item.difficulty = item.difficulty || "easy";
        item.scenario = item.scenario || "life";
        done.splice(idx, 1);
        (Array.isArray(state.todo) ? state.todo : []).push(item);
        return state;
      }
      const todo = Array.isArray(state.todo) ? state.todo : [];
      const idx = todo.findIndex(i => (i as Item).id === taskId);
      if (idx < 0) return null;
      const item = clean(todo[idx]) as Item;
      const plan = item.plan as { stages?: { steps?: { done?: boolean }[] }[] } | null;
      for (const step of (plan?.stages || []).flatMap(s => s.steps || [])) step.done = true;
      item.completed = Date.now();
      item.display = new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      todo.splice(idx, 1);
      const done = Array.isArray(state.done) ? state.done : [];
      done.push(item);
      return state;
    });
    if (!moved) throw new HttpError(404, "task_not_found", "找不到这个任务");
    const doneList = Array.isArray(moved.done) ? moved.done : [];
    const item = doneList.find(i => (i as Item).id === taskId);
    const finished = doneList.filter(i => {
      const c = Number((i as Item).completed || 0);
      return c > 1e11 && new Date(c).toISOString().slice(0, 10) === todayShanghai();
    }).length;
    const praise = praiseLine({ type: "done", title: item?.title, hard: item?.difficulty === "hard", plan: Boolean(item?.plan), n: finished, scene: item?.scenario, hour: new Date().getHours() });
    return res.json({ done: !reopen, praise });
  }));

  return router;
}

export { uid };
