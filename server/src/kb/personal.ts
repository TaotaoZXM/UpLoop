/**
 * WP3.1: personal knowledge layer. Priority is personal -> table -> model fallback.
 * Correction factors are clamped to 0.5-2.0 and blended gradually until three
 * confirmations (knowledge-base design doc §8.1).
 */
import type { Db } from "../db/pool.js";
import { blendedFactor } from "../wellness/logic/kb.js";
import type { ResolvedItem } from "../wellness/logic/food.js";

export type PersonalFood = {
  name: string;
  alias: string;
  correction_factor: number;
  typical_portion_g: number | null;
  confirmations: number;
};

export async function personalFoodFor(db: Db, userId: string, name: string): Promise<PersonalFood | null> {
  const row = await db.one<{
    name: string;
    alias: string;
    correction_factor: number;
    typical_portion_g: number | null;
    confirmations: number;
  }>(
    `SELECT name, alias, correction_factor, typical_portion_g, confirmations
     FROM personal_foods WHERE user_id = $1 AND (name = $2 OR alias = $2) LIMIT 1`,
    [userId, name],
  );
  if (!row) return null;
  return {
    name: row.name,
    alias: row.alias,
    correction_factor: Number(row.correction_factor),
    typical_portion_g: row.typical_portion_g == null ? null : Number(row.typical_portion_g),
    confirmations: Number(row.confirmations),
  };
}

export async function personalFactorFor(db: Db, userId: string, name: string) {
  const row = await personalFoodFor(db, userId, name);
  return row ? row.correction_factor : 1;
}

/** A gram correction from the day-detail page becomes one confirmation. */
export async function notePersonalPortion(db: Db, userId: string, name: string, grams: number) {
  const clean = String(name || "").trim().slice(0, 60);
  if (!clean || !Number.isFinite(grams) || grams <= 0) return;
  const current = await personalFoodFor(db, userId, clean);
  const observed = Math.min(2, Math.max(0.5, grams / 100));
  const factor = current ? blendedFactor(current.correction_factor, observed, current.confirmations) : 1;
  const portion = current?.typical_portion_g
    ? Math.round((current.typical_portion_g * 2 + grams) / 3)
    : Math.round(grams);
  await db.query(
    `INSERT INTO personal_foods (user_id, name, alias, correction_factor, typical_portion_g, confirmations, updated_at)
     VALUES ($1,$2,$2,$3,$4,1,now())
     ON CONFLICT (user_id, name) DO UPDATE SET
       correction_factor = EXCLUDED.correction_factor,
       typical_portion_g = EXCLUDED.typical_portion_g,
       confirmations = personal_foods.confirmations + 1,
       updated_at = now()`,
    [userId, clean, factor, portion],
  );
}

/** "这家量更大" style correction. `observed` is a multiplier such as 1.3. */
export async function noteSizeCorrection(db: Db, userId: string, name: string, observed: number) {
  const clean = String(name || "").trim().slice(0, 60);
  if (!clean || !Number.isFinite(observed)) return;
  const current = await personalFoodFor(db, userId, clean);
  const factor = current ? blendedFactor(current.correction_factor, observed, current.confirmations) : 1;
  await db.query(
    `INSERT INTO personal_foods (user_id, name, alias, correction_factor, confirmations, updated_at)
     VALUES ($1,$2,$2,$3,1,now())
     ON CONFLICT (user_id, name) DO UPDATE SET
       correction_factor = EXCLUDED.correction_factor,
       confirmations = personal_foods.confirmations + 1,
       updated_at = now()`,
    [userId, clean, factor],
  );
}

export function applyPersonalFactor(item: ResolvedItem, factor: number): ResolvedItem {
  if (!factor || Math.abs(factor - 1) < 0.001) return item;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const kcal = Math.round(item.kcal * factor);
  return {
    ...item,
    kcal,
    kcal_low: Math.round(item.kcal_low * factor),
    kcal_high: Math.round(item.kcal_high * factor),
    protein_g: round1(item.protein_g * factor),
    carb_g: round1(item.carb_g * factor),
    fat_g: round1(item.fat_g * factor),
    note: `${item.note} · 已按你的份量修正`,
  };
}
