/**
 * WP2.4: qingzhou-style Express routes replacing fitness-helper's http.ts.
 * No Fastify, no duplicated ACTIVITIES table, no usage amounts in responses.
 */
import { Router } from "express";
import { asyncRoute, dayOf, isYmd, monthOf } from "../http.js";
import { authUser } from "../auth/session.js";
import { HttpError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { activityByKey } from "./logic/parse.js";
import { todayShanghai } from "./logic/time.js";
import {
  addExercise,
  addManualDrink,
  addSleep,
  applyWaterSuggestion,
  daySummary,
  deleteEntry,
  listMessages,
  loadWellnessUser,
  monthMarks,
  setDayWaterGoal,
  updateFoodGrams,
  weekDays,
} from "./repo.js";

export function createWellnessRouter({ db }: AppDeps) {
  const router = Router();

  /** Manual records are unaffected by the monthly quota (PRD S-W9). */
  router.post(
    "/entries",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const day = dayOf(body.day);
      const kind = String(body.kind || "");
      if (kind === "water") {
        const saved = await addManualDrink(db, user.id, day, Number(body.ml), String(body.beverage || "白水"));
        return res.json({ entry_id: saved.id, summary: (await daySummary(db, user.id, day)).summary });
      }
      if (kind === "sleep") {
        const hasMinutes = body.minutes !== undefined && body.minutes !== null && body.minutes !== "";
        const saved = await addSleep(db, user.id, day, {
          minutes: hasMinutes ? Number(body.minutes) : null,
          bedtime: body.bedtime ? String(body.bedtime) : null,
          wake: body.wake ? String(body.wake) : null,
        });
        return res.json({
          entry_id: saved.id, minutes: saved.minutes, bedtime: saved.bedtime, wake: saved.wake,
          summary: (await daySummary(db, user.id, day)).summary,
        });
      }
      if (kind === "exercise") {
        const key = String(body.activity || "运动");
        const meta = activityByKey(key);
        const kcal = body.kcal === undefined || body.kcal === null || body.kcal === "" ? null : Number(body.kcal);
        const saved = await addExercise(db, await loadWellnessUser(db, user.id), day, {
          activity: meta?.name || key.slice(0, 24) || "未分类运动",
          met: meta?.met ?? 4,
          minutes: Number(body.minutes),
          kcal,
          unclassified: meta ? Boolean(meta.unclassified) : true,
          weightKg: body.weight_kg ? Number(body.weight_kg) : undefined,
          skipWeight: body.skip_weight === true,
        });
        if (saved.need_weight) {
          return res.status(409).json({ error: "need_weight", message: "估算消耗需要体重（公斤），也可以跳过并按 58 公斤。" });
        }
        return res.json({
          entry_id: saved.id,
          summary: (await daySummary(db, user.id, day)).summary,
          estimated: saved.estimated,
          kcal: saved.kcal,
        });
      }
      throw new HttpError(400, "kind", "记录类型不对");
    }),
  );

  router.post(
    "/entries/:id/grams",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const body = (req.body || {}) as { index?: number; grams?: number };
      const saved = await updateFoodGrams(db, user.id, req.params.id, Number(body.index), Number(body.grams));
      return res.json(saved);
    }),
  );

  router.delete(
    "/entries/:id",
    asyncRoute(async (req, res) => {
      await deleteEntry(db, authUser(req).id, req.params.id);
      return res.json({ ok: true });
    }),
  );

  /** M02-F11: day detail, switch days, edit history, recalc. */
  router.get(
    "/wellness/day",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const day = dayOf(req.query.day);
      const summary = await daySummary(db, user.id, day);
      return res.json({ ...summary, week: weekDays(day), today: todayShanghai() });
    }),
  );

  router.get(
    "/wellness/month",
    asyncRoute(async (req, res) => {
      const month = monthOf(req.query.month);
      return res.json({ month, days: await monthMarks(db, authUser(req).id, month) });
    }),
  );

  router.post(
    "/wellness/days/:day/water-goal",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const day = req.params.day;
      if (!isYmd(day)) throw new HttpError(400, "day", "日期不对");
      const body = (req.body || {}) as { ml?: number; apply_suggestion?: boolean };
      if (body.apply_suggestion) {
        return res.json({ water_goal_ml: await applyWaterSuggestion(db, user.id, day) });
      }
      await setDayWaterGoal(db, user.id, day, Number(body.ml));
      return res.json({ water_goal_ml: Number(body.ml) });
    }),
  );

  router.get(
    "/messages",
    asyncRoute(async (req, res) => {
      return res.json({ messages: await listMessages(db, authUser(req).id) });
    }),
  );

  return router;
}
