/**
 * WP1.4: /api/state keeps the JSON document (todo/done/ideas/feedback/projects).
 * Server-side task-cap validation is added (the front end already enforces it).
 * Legacy `expenses`/`routines` fields are ignored so an old cached PWA cannot
 * overwrite the newly split tables.
 */
import { Router, type Request, type Response } from "express";
import { isoTimestamp, json, nowMsIso, readJson } from "../db/pool.js";
import { asyncRoute } from "../http.js";
import { authUser } from "../auth/session.js";
import { storedStepError, validatePlan } from "../tasks/decompose.js";
import type { AppDeps } from "../types.js";

const STATE_VERSION = 1;
const MAX_STATE_CHARS = 1_000_000;

export type AppState = Record<string, unknown> & { version: number; todo?: unknown[] };

export function usableState(state: unknown): state is AppState {
  return Boolean(state && typeof state === "object" && !Array.isArray(state) && (state as AppState).version === STATE_VERSION);
}

/** Returns a human-readable reason, or null when the document is within limits. */
export function validateTaskLimits(state: AppState): string | null {
  if (state.links !== undefined) {
    if (!Array.isArray(state.links) || state.links.length > 500) return "关联最多 500 条";
    const ids = new Set();
    for (const raw of state.links) {
      const link = raw as Record<string, unknown>;
      if (!link || typeof link.id !== "string" || !link.id || link.id.length > 100 || ids.has(link.id) ||
        typeof link.from !== "string" || typeof link.to !== "string" ||
        link.from.length > 1200 || link.to.length > 1200 || link.from === link.to ||
        !/^(task|idea|routine):.+/.test(link.from) || !/^(task|idea|routine):.+/.test(link.to) ||
        !["related", "inspires", "supports", "precedes"].includes(String(link.kind))) return "关联格式不正确";
      ids.add(link.id);
    }
  }
  const todo = Array.isArray(state.todo) ? state.todo : [];
  const repeating = Array.isArray(state.repeatTasks) ? state.repeatTasks : [];
  if (repeating.length > 1000) return "循环任务规则过多，请整理历史规则";
  if (![...todo, ...(Array.isArray(state.done) ? state.done : []), ...repeating].every(raw => {
    const item = raw as Record<string, unknown>;
    return item && (!item.scenario || ["life", "work", "rest"].includes(String(item.scenario)));
  })) return "场景格式不正确";
  const validateStoredPlan = (value: unknown, mode: "task" | "draft" = "task") => {
    if (!value || typeof value !== "object") return false;
    const plan = value as { stages?: Array<{id?: unknown; steps?: Array<{id?: unknown; done?: unknown}>}> };
    if (mode === "draft") {
      if (!Array.isArray(plan.stages) || plan.stages.length > 20) return false;
      const ids = new Set<string>();let count=0;
      for(const stage of plan.stages){
        if(!stage||typeof stage.id!=="string"||!stage.id||ids.has(stage.id)||typeof (stage as {title?:unknown}).title!=="string"||(stage as {title:string}).title.length>40||!Array.isArray(stage.steps))return false;
        ids.add(stage.id);
        for(const step of stage.steps){
          if(!step||typeof step.id!=="string"||!step.id||ids.has(step.id)||typeof (step as {title?:unknown}).title!=="string"||Array.from((step as {title:string}).title).length>30||!Number.isInteger((step as {minutes?:unknown}).minutes)||(step as {minutes:number}).minutes<1||(step as {minutes:number}).minutes>240||!Number.isInteger((step as {waitDays?:unknown}).waitDays)||(step as {waitDays:number}).waitDays<0||(step as {waitDays:number}).waitDays>365||typeof (step as {done?:unknown}).done!=="boolean")return false;
          const title=(step as {title:string}).title.trim();if(title&&storedStepError(title,(step as {minutes:number}).minutes,(step as {waitDays:number}).waitDays))return false;
          if(++count>60)return false;ids.add(step.id);
        }
      }
      return true;
    }
    try { validatePlan(value, storedStepError); } catch { return false; }
    const ids = new Set();
    for (const stage of plan.stages || []) {
      if (!stage || typeof stage.id !== "string" || !stage.id || ids.has(stage.id)) return false;
      ids.add(stage.id);
      for (const step of stage.steps || []) {
        if (!step || typeof step.id !== "string" || !step.id || ids.has(step.id) || typeof step.done !== "boolean") return false;
        ids.add(step.id);
      }
    }
    return true;
  };
  if (state.planDrafts !== undefined && (!Array.isArray(state.planDrafts) || state.planDrafts.length > 100)) return "拆解草稿最多100份";
  for (const draft of (Array.isArray(state.planDrafts) ? state.planDrafts : []) as Array<Record<string,unknown>>) {
    if (!draft || typeof draft.id !== "string" || typeof draft.title !== "string" || !draft.title.trim() || !validateStoredPlan(draft.plan, "draft")) return "拆解草稿格式不正确";
  }
  if (state.checklists !== undefined && (!Array.isArray(state.checklists) || state.checklists.length > 1000)) return "Checklist 清单格式不正确";
  for (const item of [...todo, ...(Array.isArray(state.done) ? state.done : []), ...repeating, ...(Array.isArray(state.checklists) ? state.checklists : [])] as Array<Record<string,unknown>>) {
    if (item.plan != null && !validateStoredPlan(item.plan)) return "任务拆解清单格式不正确";
    if (item.occurrencePlans != null) {
      if (typeof item.occurrencePlans !== "object" || Array.isArray(item.occurrencePlans)) return "循环清单格式不正确";
      for (const [day, plan] of Object.entries(item.occurrencePlans as object)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !validateStoredPlan(plan)) return "循环清单格式不正确";
      }
    }
  }
  const repeatIds = new Set<string>();
  for (const raw of repeating) {
    const item = raw as Record<string, unknown>;
    if (!item || typeof item.id !== "string" || !item.id || typeof item.title !== "string" || !item.title.trim() ||
      !Number.isInteger(item.repeatDays) || Number(item.repeatDays) < 1 || Number(item.repeatDays) > 365 ||
      typeof item.startDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.startDay) || Number.isNaN(Date.parse(`${item.startDay}T12:00:00Z`)) ||
      new Date(`${item.startDay}T12:00:00Z`).toISOString().slice(0, 10) !== item.startDay || repeatIds.has(item.id) ||
      !["life", "work", "rest"].includes(String(item.scenario || "life"))) return "循环任务格式不正确";
    repeatIds.add(item.id as string);
  }
  return null;
}

/** WP1.4.4: old clients still send these fields; drop them before persisting. */
export function stripLegacyFields(state: AppState) {
  const clean = { ...state } as Record<string, unknown>;
  const ignoredFields: string[] = [];
  for (const field of ["expenses", "routines"]) {
    if (Object.prototype.hasOwnProperty.call(clean, field)) {
      delete clean[field];
      ignoredFields.push(field);
    }
  }
  return { state: clean as AppState, ignoredFields };
}

export function createStateRouter({ db }: AppDeps) {
  const router = Router();

  router.get(
    "/state",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const row = await db.one<{ state: unknown; updated_at: unknown }>(
        "SELECT state, updated_at FROM user_app_state WHERE user_id = $1 LIMIT 1",
        [user.id],
      );
      const state = row ? readJson<AppState | null>(row.state, null) : null;
      return res.json({
        state: usableState(state) ? stripLegacyFields(state).state : null,
        updatedAt: row ? isoTimestamp(row.updated_at) : null,
      });
    }),
  );

  router.put(
    "/state",
    asyncRoute(async (req: Request, res: Response) => {
      const user = authUser(req);
      if (!usableState(req.body?.state)) return res.status(400).json({ error: "invalid_state", message: "数据格式不正确" });
      const { state: clean, ignoredFields } = stripLegacyFields(req.body.state as AppState);
      const limitError = validateTaskLimits(clean);
      if (limitError) return res.status(400).json({ error: "task_limit", message: limitError });
      const payload = JSON.stringify(clean);
      if (payload.length > MAX_STATE_CHARS) return res.status(413).json({ error: "too_large", message: "数据过大" });

      const hasBase = Object.prototype.hasOwnProperty.call(req.body || {}, "baseUpdatedAt");
      const baseRaw = hasBase ? req.body.baseUpdatedAt : null;
      if (baseRaw != null && typeof baseRaw !== "string") {
        return res.status(400).json({ error: "invalid_state", message: "数据格式不正确" });
      }
      const baseUpdatedAt = baseRaw ? isoTimestamp(baseRaw) : null;
      if (baseRaw && !baseUpdatedAt) return res.status(400).json({ error: "invalid_state", message: "数据格式不正确" });

      const writtenAt = nowMsIso();
      try {
        const outcome = await db.tx(async (tx) => {
          const current = (await tx.query<{ state: unknown; updated_at: unknown }>(
            "SELECT state, updated_at FROM user_app_state WHERE user_id = $1 LIMIT 1 FOR UPDATE",
            [user.id],
          )).rows[0];
          const currentUpdatedAt = current ? isoTimestamp(current.updated_at) : null;
          if ((current && currentUpdatedAt !== baseUpdatedAt) || (!current && baseUpdatedAt)) {
            const serverState = current ? readJson<AppState | null>(current.state, null) : null;
            return {
              conflict: {
                error: "云端数据已更新，请合并后再试",
                state: usableState(serverState) ? stripLegacyFields(serverState).state : null,
                updatedAt: currentUpdatedAt,
              },
            };
          }
          if (current) {
            await tx.query(
              "UPDATE user_app_state SET state = $1::jsonb, updated_at = $2::timestamptz WHERE user_id = $3",
              [json(clean), writtenAt, user.id],
            );
          } else {
            await tx.query(
              "INSERT INTO user_app_state (user_id, state, updated_at) VALUES ($1, $2::jsonb, $3::timestamptz)",
              [user.id, json(clean), writtenAt],
            );
          }
          return { conflict: null };
        });
        if (outcome.conflict) return res.status(409).json(outcome.conflict);
        const response: Record<string, unknown> = { state: clean, updatedAt: isoTimestamp(writtenAt) };
        if (ignoredFields.length) response.ignoredFields = ignoredFields;
        return res.json(response);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          return res.status(409).json({ error: "云端数据已更新，请合并后再试", state: null, updatedAt: null });
        }
        throw error;
      }
    }),
  );

  return router;
}
