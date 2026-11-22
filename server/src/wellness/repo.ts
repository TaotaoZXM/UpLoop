/**
 * WP2.4: service.ts (SQLite, synchronous) rewritten as an async PostgreSQL repo.
 * Account/session/onboarding functions were NOT migrated — those belong to the
 * qingzhou account system and WP2.2's user_profile.
 */
import { randomUUID } from "node:crypto";
import { json, nowMsIso, readJson, type Db } from "../db/pool.js";
import { CATALOG_VERSION } from "../env.js";
import { HttpError } from "../errors.js";
import { markDayDirty, projectLifeEvent } from "../memory/projection.js";
import { recordMetric } from "../usage/quota.js";
import { FOOD_BY_ID } from "./logic/catalog.js";
import { recalcItem, resolveTableItem, sumItems, type ResolvedItem } from "./logic/food.js";
import { addDays, shanghaiParts, shortDay, todayShanghai, weekdayLabel } from "./logic/time.js";

export type WellnessUser = {
  id: string;
  waterGoalMl: number;
  weightKg: number | null;
  weightSkipped: boolean;
  pending: unknown;
  onboarded: boolean;
  cloudConsent: boolean | null;
};

export async function loadWellnessUser(db: Db, userId: string): Promise<WellnessUser> {
  const row = await db.one<{
    user_id: string;
    water_goal_ml: number | null;
    weight_kg: number | null;
    weight_skipped: boolean;
    pending: unknown;
    onboarded_at: string | null;
    cloud_consent: boolean | null;
  }>(
    `SELECT user_id, water_goal_ml, weight_kg, weight_skipped, pending, onboarded_at, cloud_consent
     FROM user_profile WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return {
    id: userId,
    waterGoalMl: Number(row?.water_goal_ml || 1500),
    weightKg: row?.weight_kg == null ? null : Number(row.weight_kg),
    weightSkipped: Boolean(row?.weight_skipped),
    pending: readJson<unknown>(row?.pending, null),
    onboarded: Boolean(row?.onboarded_at),
    cloudConsent: row?.cloud_consent ?? null,
  };
}

export type EntryRow = {
  id: string;
  user_id: string;
  day: string;
  kind: string;
  occurred_at: string;
  source_text: string | null;
  estimated: boolean;
  kcal: number;
  kcal_low: number | null;
  kcal_high: number | null;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  water_ml: number;
  sleep_min: number;
  exercise_min: number;
  detail: unknown;
  kb_version: number;
};

function mapEntry(row: Record<string, unknown>): EntryRow {
  const detail = readJson<unknown>(row.detail, {});
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    day: String(row.day).slice(0, 10),
    kind: String(row.kind),
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    source_text: row.source_text == null ? null : String(row.source_text),
    estimated: Boolean(row.estimated),
    kcal: Number(row.kcal || 0),
    kcal_low: row.kcal_low == null ? null : Number(row.kcal_low),
    kcal_high: row.kcal_high == null ? null : Number(row.kcal_high),
    protein_g: Number(row.protein_g || 0),
    carb_g: Number(row.carb_g || 0),
    fat_g: Number(row.fat_g || 0),
    water_ml: Number(row.water_ml || 0),
    sleep_min: Number(row.sleep_min || 0),
    exercise_min: Number(row.exercise_min || 0),
    detail,
    kb_version: Number(row.kb_version || 1),
  };
}

const ENTRY_COLUMNS = `id, user_id, day, kind, occurred_at, source_text, estimated, kcal,
  kcal_low, kcal_high, protein_g, carb_g, fat_g, water_ml, sleep_min, exercise_min,
  detail, kb_version`;

export async function listEntries(db: Db, userId: string, day: string) {
  const rows = await db.rows<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS} FROM wellness_entries WHERE user_id = $1 AND day = $2 ORDER BY occurred_at ASC`,
    [userId, day],
  );
  return rows.map(mapEntry);
}

type InsertInput = {
  userId: string;
  day: string;
  kind: "food" | "water" | "sleep" | "exercise";
  sourceText?: string | null;
  estimated?: boolean;
  kcal?: number;
  kcalLow?: number | null;
  kcalHigh?: number | null;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  water_ml?: number;
  sleep_min?: number;
  exercise_min?: number;
  detail: unknown;
  source?: string;
};

export async function insertEntry(db: Db, input: InsertInput) {
  const id = randomUUID();
  const at = nowMsIso();
  await db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO wellness_entries
         (id, user_id, day, kind, occurred_at, source_text, estimated, kcal, kcal_low, kcal_high,
          protein_g, carb_g, fat_g, water_ml, sleep_min, exercise_min, detail, kb_version, updated_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,now())`,
      [
        id, input.userId, input.day, input.kind, at, input.sourceText || null,
        Boolean(input.estimated), input.kcal || 0, input.kcalLow ?? null, input.kcalHigh ?? null,
        input.protein_g || 0, input.carb_g || 0, input.fat_g || 0,
        input.water_ml || 0, input.sleep_min || 0, input.exercise_min || 0,
        json(input.detail), CATALOG_VERSION,
      ],
    );
    await projectLifeEvent(tx, {
      userId: input.userId,
      type: `wellness_${input.kind}`,
      day: input.day,
      refTable: "wellness_entries",
      refId: id,
      payload: { kind: input.kind, kcal: input.kcal || 0, estimated: Boolean(input.estimated), source: input.source || "chat" },
      occurredAt: at,
    });
  });
  await recordMetric(db, input.userId, "log", { kind: input.kind });
  return id;
}

function itemRange(items: ResolvedItem[]) {
  const low = items.reduce((sum, item) => sum + (item.kcal_low ?? item.kcal), 0);
  const high = items.reduce((sum, item) => sum + (item.kcal_high ?? item.kcal), 0);
  return { kcalLow: Math.round(low), kcalHigh: Math.round(high) };
}

export async function saveFoodEntry(db: Db, userId: string, day: string, source: string, items: ResolvedItem[]) {
  const totals = sumItems(items);
  for (const item of items) {
    await recordMetric(db, userId, item.lookup === "table" ? "lookup_hit" : "lookup_miss", { name: item.name });
  }
  const range = itemRange(items);
  const id = await insertEntry(db, {
    userId, day, kind: "food", sourceText: source, estimated: true,
    ...totals, ...range, detail: { items },
  });
  return { id, totals, items, entryId: id };
}

export async function replaceFoodItems(db: Db, userId: string, entryId: string, items: ResolvedItem[]) {
  const row = await db.one<{ kind: string; day: string }>(
    "SELECT kind, day FROM wellness_entries WHERE id = $1 AND user_id = $2",
    [entryId, userId],
  );
  if (!row || row.kind !== "food") throw new HttpError(404, "not_found", "没有这条饮食");
  const totals = sumItems(items);
  const range = itemRange(items);
  await db.query(
    `UPDATE wellness_entries SET kcal = $1, kcal_low = $2, kcal_high = $3, protein_g = $4,
        carb_g = $5, fat_g = $6, water_ml = $7, detail = $8::jsonb, estimated = true,
        kb_version = $9, updated_at = now()
     WHERE id = $10`,
    [
      totals.kcal, range.kcalLow, range.kcalHigh, totals.protein_g, totals.carb_g,
      totals.fat_g, totals.water_ml, json({ items }), CATALOG_VERSION, entryId,
    ],
  );
  await markDayDirty(db, userId, String(row.day).slice(0, 10));
  return { id: entryId, totals, items };
}

export async function updateFoodGrams(db: Db, userId: string, entryId: string, index: number, grams: number) {
  const row = await db.one<{ kind: string; detail: unknown; day: string }>(
    "SELECT kind, detail, day FROM wellness_entries WHERE id = $1 AND user_id = $2",
    [entryId, userId],
  );
  if (!row || row.kind !== "food") throw new HttpError(404, "not_found", "没有这条饮食");
  if (!Number.isFinite(grams) || grams <= 0 || grams > 5000) throw new HttpError(400, "grams", "克重不合理");
  const detail = readJson<{ items: ResolvedItem[] }>(row.detail, { items: [] });
  if (!detail.items[index]) throw new HttpError(400, "grams", "没有这味食材");
  detail.items[index] = recalcItem(detail.items[index], grams);
  detail.items[index].grams_estimated = false;
  // WP3.1: a gram correction feeds the personal knowledge layer.
  await recordPersonalCorrection(db, userId, detail.items[index], grams);
  return replaceFoodItems(db, userId, entryId, detail.items);
}

/** WP3.1: personal correction factor 0.5-2.0, progressive until 3 confirmations. */
async function recordPersonalCorrection(db: Db, userId: string, item: ResolvedItem, grams: number) {
  if (!item.food_id) return;
  await import("../kb/personal.js").then(({ notePersonalPortion }) =>
    notePersonalPortion(db, userId, item.name, grams),
  ).catch(() => undefined);
}

export async function deleteEntry(db: Db, userId: string, entryId: string) {
  const result = await db.query(
    "DELETE FROM wellness_entries WHERE id = $1 AND user_id = $2 RETURNING day",
    [entryId, userId],
  );
  if (!result.rowCount) throw new HttpError(404, "not_found", "没有这条记录");
  const day = String((result.rows[0] as { day?: string })?.day || todayShanghai()).slice(0, 10);
  await markDayDirty(db, userId, day);
}

/** PRD M02-F7: suggestion only, never applied automatically, never reads physiology. */
export function waterSuggestion(base: number, exerciseMin: number) {
  if (exerciseMin <= 0 || base <= 0) return null;
  const add = Math.min(Math.ceil(exerciseMin / 30) * 300, base * 0.5);
  return { add_ml: Math.round(add), target_ml: Math.round(base + add), label: "建议，可改" };
}

export type DaySummary = {
  day: string;
  label: string;
  weekday: string;
  is_today: boolean;
  base_water_ml: number;
  summary: {
    kcal: number;
    protein_g: number;
    carb_g: number;
    fat_g: number;
    water_ml: number;
    sleep_min: number;
    exercise_min: number;
    exercise_kcal: number;
    food_estimated: boolean;
    exercise_estimated: boolean;
    kcal_low: number;
    kcal_high: number;
    water_goal_ml: number;
    water_ratio: number;
    sleep_bedtime: string | null;
    sleep_wake: string | null;
  };
  suggestion: ReturnType<typeof waterSuggestion>;
  entries: EntryRow[];
};

export async function daySummary(db: Db, userId: string, day: string): Promise<DaySummary> {
  const [entries, user, setting] = await Promise.all([
    listEntries(db, userId, day),
    loadWellnessUser(db, userId),
    db.one<{ water_goal_ml: number | null; suggestion_applied: boolean }>(
      "SELECT water_goal_ml, suggestion_applied FROM wellness_day_settings WHERE user_id = $1 AND day = $2",
      [userId, day],
    ),
  ]);
  const totals = entries.reduce(
    (acc, entry) => {
      acc.kcal += entry.kcal;
      acc.kcal_low += entry.kcal_low ?? entry.kcal;
      acc.kcal_high += entry.kcal_high ?? entry.kcal;
      acc.protein_g += entry.protein_g;
      acc.carb_g += entry.carb_g;
      acc.fat_g += entry.fat_g;
      acc.water_ml += entry.water_ml;
      acc.sleep_min += entry.sleep_min;
      acc.exercise_min += entry.exercise_min;
      acc.exercise_kcal += entry.kind === "exercise" ? entry.kcal : 0;
      if (entry.kind === "food") acc.food_estimated = true;
      if (entry.kind === "exercise" && entry.estimated) acc.exercise_estimated = true;
      return acc;
    },
    {
      kcal: 0, kcal_low: 0, kcal_high: 0, protein_g: 0, carb_g: 0, fat_g: 0,
      water_ml: 0, sleep_min: 0, exercise_min: 0, exercise_kcal: 0,
      food_estimated: false, exercise_estimated: false,
    },
  );
  const sleepEntry = [...entries].reverse().find((entry) => entry.kind === "sleep");
  const sleepDetail = (sleepEntry?.detail || {}) as { bedtime?: string | null; wake?: string | null };
  const base = user.waterGoalMl || 1500;
  const goal = Number(setting?.water_goal_ml || base);
  const suggestion = waterSuggestion(base, totals.exercise_min);
  const showSuggestion = Boolean(suggestion && goal < suggestion.target_ml);
  return {
    day,
    label: shortDay(day),
    weekday: weekdayLabel(day),
    is_today: day === todayShanghai(),
    base_water_ml: base,
    summary: {
      kcal: Math.round(totals.kcal),
      kcal_low: Math.round(totals.kcal_low),
      kcal_high: Math.round(totals.kcal_high),
      protein_g: Math.round(totals.protein_g * 10) / 10,
      carb_g: Math.round(totals.carb_g * 10) / 10,
      fat_g: Math.round(totals.fat_g * 10) / 10,
      water_ml: totals.water_ml,
      sleep_min: totals.sleep_min,
      exercise_min: totals.exercise_min,
      exercise_kcal: Math.round(totals.exercise_kcal),
      food_estimated: totals.food_estimated,
      exercise_estimated: totals.exercise_estimated,
      water_goal_ml: goal,
      water_ratio: goal ? Math.round((totals.water_ml / goal) * 100) : 0,
      sleep_bedtime: sleepDetail.bedtime || null,
      sleep_wake: sleepDetail.wake || null,
    },
    suggestion: showSuggestion ? suggestion : null,
    entries,
  };
}

export async function setDayWaterGoal(db: Db, userId: string, day: string, ml: number) {
  if (!Number.isFinite(ml) || ml < 500 || ml > 8000) throw new HttpError(400, "water", "喝水目标请填 500 到 8000 毫升");
  await db.query(
    `INSERT INTO wellness_day_settings (user_id, day, water_goal_ml, suggestion_applied)
     VALUES ($1,$2,$3,false)
     ON CONFLICT (user_id, day) DO UPDATE SET water_goal_ml = EXCLUDED.water_goal_ml`,
    [userId, day, Math.round(ml)],
  );
}

export async function applyWaterSuggestion(db: Db, userId: string, day: string) {
  const summary = await daySummary(db, userId, day);
  if (!summary.suggestion) throw new HttpError(400, "suggestion", "今天没有可应用的运动补水建议");
  await db.query(
    `INSERT INTO wellness_day_settings (user_id, day, water_goal_ml, suggestion_applied)
     VALUES ($1,$2,$3,true)
     ON CONFLICT (user_id, day) DO UPDATE SET water_goal_ml = EXCLUDED.water_goal_ml, suggestion_applied = true`,
    [userId, day, summary.suggestion.target_ml],
  );
  return summary.suggestion.target_ml;
}

const DRINK_IDS: Record<string, string> = {
  白水: "water",
  茶: "tea",
  咖啡: "amer",
  无糖汽水: "diet-cola",
  含糖饮料: "sugary",
  酒: "generic-alcohol",
};

export async function addManualDrink(db: Db, userId: string, day: string, ml: number, beverage: string) {
  const id = DRINK_IDS[beverage];
  const food = id ? FOOD_BY_ID.get(id) : undefined;
  if (!food) throw new HttpError(400, "drink", "饮料类型不在选项里");
  if (!Number.isFinite(ml) || ml <= 0 || ml > 5000) throw new HttpError(400, "ml", "毫升数不合理");
  const item = resolveTableItem({ food, grams: ml, gramsEstimated: false, portion: `${ml} ml`, state: "饮品" });
  if (food.flag === "alcohol" || item.kcal > 0) {
    // 酒只记热量不计水；含糖饮料同时计水与热。
    const adjusted = food.flag === "alcohol" ? { ...item, water_ml: 0 } : item;
    return saveFoodEntry(db, userId, day, `${beverage}${ml}ml`, [adjusted]);
  }
  const entryId = await insertEntry(db, {
    userId, day, kind: "water", sourceText: `${beverage}${ml}ml`,
    water_ml: ml, detail: { ml, beverage, counts: true }, source: "form",
  });
  return {
    id: entryId,
    totals: { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, water_ml: ml },
    items: [item],
  };
}

function isHm(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function shanghaiClock(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function minutesBetween(bed: string, wake: string) {
  const [bh, bm] = bed.split(":").map(Number);
  const [wh, wm] = wake.split(":").map(Number);
  let diff = wh * 60 + wm - (bh * 60 + bm);
  if (diff < 0) diff += 24 * 60;
  return diff > 0 ? diff : null;
}

export type SleepResult = { id: string; minutes: number | null; bedtime: string | null; wake: string | null };

/** M02-F8: only timestamps/duration, never an evaluation. */
export async function addSleep(
  db: Db,
  userId: string,
  day: string,
  input: { minutes?: number | null; bedtime?: string | null; wake?: string | null },
): Promise<SleepResult> {
  const bedtime = input.bedtime === "now" ? shanghaiClock() : input.bedtime || null;
  const wake = input.wake === "now" ? shanghaiClock() : input.wake || null;
  let minutes = input.minutes ?? null;
  if (bedtime && !isHm(bedtime)) throw new HttpError(400, "sleep", "入睡时间请用 23:10 这种格式");
  if (wake && !isHm(wake)) throw new HttpError(400, "sleep", "起床时间请用 07:10 这种格式");
  if (wake && !bedtime && minutes == null) {
    const open = (await db.rows<{ id: string; day: string; detail: unknown }>(
      "SELECT id, day, detail FROM wellness_entries WHERE user_id = $1 AND kind = 'sleep' ORDER BY occurred_at DESC LIMIT 8",
      [userId],
    )).map((row) => {
      const detail = readJson<{ bedtime?: string | null; wake?: string | null; minutes?: number | null }>(row.detail, {});
      return { id: row.id, day: row.day, detail };
    }).find((row) => Boolean(row.detail.bedtime) && !row.detail.wake);
    if (open) {
      const span = open.detail.bedtime ? minutesBetween(open.detail.bedtime, wake) : null;
      if (span != null && span > 20 * 60) throw new HttpError(400, "sleep", "睡眠时长不合理");
      await db.query(
        "UPDATE wellness_entries SET sleep_min = $1, day = $2, detail = $3::jsonb, updated_at = now() WHERE id = $4",
        [span || 0, day, json({ ...open.detail, wake, minutes: span }), open.id],
      );
      await markDayDirty(db, userId, String(open.day).slice(0, 10));
      return { id: open.id, minutes: span, bedtime: open.detail.bedtime || null, wake };
    }
  }
  if (bedtime && wake && minutes == null) minutes = minutesBetween(bedtime, wake);
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 20 * 60)) {
    throw new HttpError(400, "sleep", "睡眠时长不合理");
  }
  if (minutes == null && !bedtime && !wake) throw new HttpError(400, "sleep", "请写下睡眠时长，或入睡、起床时间");
  const rounded = minutes ? Math.round(minutes) : null;
  const id = await insertEntry(db, {
    userId, day, kind: "sleep", sleep_min: rounded || 0,
    detail: { minutes: rounded, bedtime, wake },
  });
  return { id, minutes: rounded, bedtime, wake };
}

export function exerciseKcal(met: number, kg: number, minutes: number) {
  return Math.round(met * kg * (minutes / 60));
}

export type ExerciseResult =
  | { need_weight: true; user: WellnessUser }
  | { need_weight: false; id: string; kcal: number; estimated: boolean; user: WellnessUser };

/** M02-F9: MET table includes climbing (8); unrecognised activities are never dropped. */
export async function addExercise(
  db: Db,
  user: WellnessUser,
  day: string,
  input: {
    activity: string;
    met: number;
    minutes: number;
    kcal: number | null;
    unclassified?: boolean;
    weightKg?: number;
    skipWeight?: boolean;
  },
): Promise<ExerciseResult> {
  if (!Number.isFinite(input.minutes) || input.minutes <= 0 || input.minutes > 600) {
    throw new HttpError(400, "exercise", "运动时长不合理");
  }
  let estimated = false;
  let kcal = input.kcal;
  let active = user;
  if (kcal === null || kcal === undefined || Number.isNaN(kcal)) {
    if (input.weightKg) {
      await db.query("UPDATE user_profile SET weight_kg = $1, updated_at = now() WHERE user_id = $2", [input.weightKg, user.id]);
      active = await loadWellnessUser(db, user.id);
    } else if (input.skipWeight) {
      await db.query("UPDATE user_profile SET weight_skipped = true, updated_at = now() WHERE user_id = $1", [user.id]);
      active = await loadWellnessUser(db, user.id);
    } else if (!user.weightKg && !user.weightSkipped) {
      return { need_weight: true, user };
    }
    const kg = active.weightKg || 58;
    kcal = exerciseKcal(input.met, kg, input.minutes);
    estimated = true;
  }
  const id = await insertEntry(db, {
    userId: user.id, day, kind: "exercise", estimated, kcal: Math.round(kcal),
    exercise_min: Math.round(input.minutes),
    detail: {
      activity: input.activity,
      minutes: Math.round(input.minutes),
      kcal: Math.round(kcal),
      met: input.met,
      weight_kg: active.weightKg || 58,
      estimated,
      unclassified: Boolean(input.unclassified),
      user_provided: !estimated,
    },
  });
  return { need_weight: false, id, kcal: Math.round(kcal), estimated, user: await loadWellnessUser(db, user.id) };
}

export async function setPending(db: Db, userId: string, pending: unknown) {
  await db.query(
    "UPDATE user_profile SET pending = $1::jsonb, updated_at = now() WHERE user_id = $2",
    [pending ? json(pending) : null, userId],
  );
}

export async function saveMessage(db: Db, userId: string, role: string, content: string, day: string, meta: unknown) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO chat_messages (id, user_id, role, content, day, meta, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp())`,
    [id, userId, role, content, day, json(meta)],
  );
  return id;
}

export async function listMessages(db: Db, userId: string, limit = 80) {
  const rows = await db.rows<{ id: string; role: string; content: string; day: string; created_at: unknown; meta: unknown }>(
    "SELECT id, role, content, day, created_at, meta FROM chat_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit],
  );
  return rows.reverse().map((row) => ({ ...row, meta: readJson<unknown>(row.meta, {}) }));
}

export async function monthMarks(db: Db, userId: string, month: string) {
  const rows = await db.rows<{ day: string }>(
    "SELECT DISTINCT day FROM wellness_entries WHERE user_id = $1 AND day >= $2 AND day < $3 ORDER BY day",
    [userId, `${month}-01`, `${month}-31`],
  );
  return rows.map((row) => String(row.day).slice(0, 10));
}

export function weekDays(day: string) {
  const index = new Date(`${day}T00:00:00Z`).getUTCDay();
  const mondayOffset = index === 0 ? -6 : 1 - index;
  const monday = addDays(day, mondayOffset);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    return { day: date, weekday: weekdayLabel(date), date: Number(date.slice(-2)), selected: date === day };
  });
}
