import { FOOD_BY_ID, PORTIONS, type Food, type Portion, allAliases } from "./catalog.js";
import { intervalFor } from "./kb.js";

export type Scaled = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
};

export type ResolvedItem = {
  name: string;
  food_id: string | null;
  grams: number;
  grams_estimated: boolean;
  portion: string | null;
  state: string | null;
  lookup: "table" | "model" | "missing";
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  water_ml: number;
  note: string;
  per100: { kcal: number; p: number; c: number; f: number } | null;
  /** WP3.1: numbers carry a range and confidence; see logic/kb.ts for the widths. */
  kcal_low: number;
  kcal_high: number;
  confidence: number;
};

export function round1(n: number) {
  return Math.round(n * 10) / 10;
}

export function scalePer100(per: { kcal: number; p: number; c: number; f: number }, grams: number): Scaled {
  const factor = grams / 100;
  return {
    kcal: Math.round(per.kcal * factor),
    protein_g: round1(per.p * factor),
    carb_g: round1(per.c * factor),
    fat_g: round1(per.f * factor),
  };
}

export function countsAsWater(food: Food) {
  return food.flag === "water" || food.flag === "caloric";
}

export function portionFor(foodId: string, unit: string): Portion | undefined {
  return PORTIONS.find((row) => row.foodId === foodId && row.unit === unit);
}

const CJK = /[\u4e00-\u9fff]/;

export function matchFood(text: string): { food: Food; alias: string; index: number } | null {
  let best: { food: Food; alias: string; index: number } | null = null;
  for (const hit of allAliases()) {
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(hit.alias, from);
      if (index < 0) break;
      from = index + hit.alias.length;
      const next = text[index + hit.alias.length];
      if (next && CJK.test(next)) continue;
      if (!best || hit.alias.length > best.alias.length) {
        best = { food: hit.food, alias: hit.alias, index };
      }
    }
  }
  return best;
}

export function resolveTableItem(input: {
  food: Food;
  grams: number;
  gramsEstimated: boolean;
  portion: string | null;
  state?: string | null;
}): ResolvedItem {
  const per = { kcal: input.food.kcal, p: input.food.p, c: input.food.c, f: input.food.f };
  const scaled = scalePer100(per, input.grams);
  const water = countsAsWater(input.food) ? Math.round(input.grams) : 0;
  return {
    name: input.food.name,
    food_id: input.food.id,
    grams: input.grams,
    grams_estimated: input.gramsEstimated,
    portion: input.portion,
    state: input.state || null,
    lookup: "table",
    ...scaled,
    water_ml: water,
    note: input.food.note,
    per100: per,
    ...intervalFor(input.gramsEstimated ? "table_portion" : "table", scaled.kcal),
  };
}

export function resolveModelItem(input: {
  name: string;
  grams: number;
  per100: { kcal: number; p: number; c: number; f: number };
}): ResolvedItem {
  const scaled = scalePer100(input.per100, input.grams);
  return {
    name: input.name,
    food_id: null,
    grams: input.grams,
    grams_estimated: true,
    portion: null,
    state: null,
    lookup: "model",
    ...scaled,
    water_ml: 0,
    note: "表内未命中，模型估算",
    per100: input.per100,
    ...intervalFor("model", scaled.kcal),
  };
}

export function recalcItem(item: ResolvedItem, grams: number): ResolvedItem {
  const food = item.food_id ? FOOD_BY_ID.get(item.food_id) : undefined;
  if (food) {
    return resolveTableItem({
      food,
      grams,
      gramsEstimated: item.grams_estimated,
      portion: item.portion,
      state: item.state,
    });
  }
  if (item.per100) {
    return resolveModelItem({ name: item.name, grams, per100: item.per100 });
  }
  return { ...item, grams, kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, water_ml: 0, lookup: "missing", ...intervalFor("missing", 0) };
}

export function sumItems(items: ResolvedItem[]) {
  return items.reduce(
    (acc, item) => {
      acc.kcal += item.kcal;
      acc.protein_g = round1(acc.protein_g + item.protein_g);
      acc.carb_g = round1(acc.carb_g + item.carb_g);
      acc.fat_g = round1(acc.fat_g + item.fat_g);
      acc.water_ml += item.water_ml;
      return acc;
    },
    { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, water_ml: 0 },
  );
}
