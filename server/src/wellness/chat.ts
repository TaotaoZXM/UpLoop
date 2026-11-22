/**
 * WP2.4: fitness-helper's chat.ts migrated. Every service call is now awaited and
 * takes the injected Db. `finish()` no longer returns a `usage` object (F-S5:
 * no amounts on any application surface). Cloud-consent and quota checks live in
 * the unified router, not here.
 */
import { createHash } from "node:crypto";
import type { Db } from "../db/pool.js";
import { CATALOG_VERSION, env } from "../env.js";
import { HttpError } from "../errors.js";
import { applyPersonalFactor, personalFactorFor } from "../kb/personal.js";
import { recordMetric, assertCanCall, cacheGet, cacheSet, recordUsage } from "../usage/quota.js";
import { FOOD_BY_ID } from "./logic/catalog.js";
import { matchFood, resolveModelItem, resolveTableItem, type ResolvedItem } from "./logic/food.js";
import { deepseekChat, LlmError, PARSE_TOOL } from "./logic/llm.js";
import { looksLikeLog, normalizeText, parseLog, type ExerciseDraft } from "./logic/parse.js";
import { CONSULT_REPLY, RECORD_ONLY_REPLY, REMOVED_AUDIO_REPLY, isConsult, isMedical, isRemovedAudio, medicalReply } from "./logic/rules.js";
import { todayShanghai } from "./logic/time.js";
import {
  addExercise,
  addSleep,
  insertEntry,
  loadWellnessUser,
  saveFoodEntry,
  setPending,
  type WellnessUser,
} from "./repo.js";

export type ChatCard = {
  type: string;
  entry_id?: string;
  estimated?: boolean;
  kcal?: number;
  kcal_low?: number;
  kcal_high?: number;
  confidence?: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  water_ml?: number;
  minutes?: number;
  items?: ResolvedItem[];
  text?: string;
};

export type HandlerResult = {
  reply: string;
  intent: string;
  cards: ChatCard[];
  model: string;
  blocked?: boolean;
};

export type WellnessDeps = { db: Db };

function hashKey(prefix: string, text: string) {
  return createHash("sha256").update(`${prefix}:${CATALOG_VERSION}:${text}`).digest("hex");
}

function formatMinutes(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} 小时 ${m} 分`;
  if (h) return `${h} 小时`;
  return `${m} 分钟`;
}

function formatSleep(saved: { minutes: number | null; bedtime: string | null; wake: string | null }) {
  const lines = ["已记下睡眠。"];
  if (saved.bedtime) lines.push(`入睡 ${saved.bedtime}`);
  if (saved.wake) lines.push(`起床 ${saved.wake}`);
  if (saved.minutes) lines.push(`时长 ${formatMinutes(saved.minutes)}`);
  else if (saved.bedtime && !saved.wake) lines.push("时长等起床后再记。可以说「我醒了」。");
  return lines.join("\n");
}

function foodNote(items: ResolvedItem[]) {
  const flags = items.map((item) => (item.food_id ? FOOD_BY_ID.get(item.food_id)?.flag : null));
  const notes: string[] = [];
  if (flags.includes("caloric")) notes.push("含糖或有热量的饮料已同时计入喝水。");
  if (flags.includes("alcohol")) notes.push("酒只记了热量，没有计入喝水。");
  if (flags.includes("water")) notes.push("这一笔也计入了喝水。");
  return notes;
}

function exerciseReply(activity: string, minutes: number, kcal: number, estimated: boolean, detail: string) {
  const tag = estimated ? `约 ${kcal} kcal · 估算` : `${kcal} kcal`;
  return `已记入今天运动。\n${activity} ${minutes} 分钟 · ${tag}${detail ? `\n${detail}` : ""}`;
}

/** The unified router owns message persistence; `finish` only records metrics. */
async function finish(db: Db, user: WellnessUser, _day: string, _text: string, result: HandlerResult) {
  if (result.intent === "medical") {
    await recordMetric(db, user.id, result.reply.includes("请尽快就医") ? "emergency_refuse" : "medical_refuse");
  }
  if (result.intent === "consult_blocked") await recordMetric(db, user.id, "consult_blocked");
  if (result.intent === "removed_feature") await recordMetric(db, user.id, "removed_feature");
  return result;
}

async function estimatePer100(db: Db, userId: string, name: string) {
  const key = hashKey("est", normalizeText(name));
  const cached = await cacheGet<{ kcal: number; p: number; c: number; f: number }>(db, key);
  if (cached) return cached;
  await assertCanCall(db, userId);
  const content = await deepseekChat({
    kind: "estimate",
    messages: [
      { role: "system", content: '只输出 JSON：{"kcal":0,"p":0,"c":0,"f":0}，表示每 100 克的能量和蛋白质、碳水、脂肪。不要解释，不要链接。' },
      { role: "user", content: name },
    ],
    onTool: () => "",
    onUsage: (usage, kind, status) => recordUsage(db, userId, kind, usage, status),
  });
  const matched = content.match(/\{[\s\S]*\}/);
  if (!matched) return null;
  const parsed = JSON.parse(matched[0]) as { kcal?: number; p?: number; c?: number; f?: number };
  if (typeof parsed.kcal !== "number") return null;
  const per = { kcal: parsed.kcal, p: Number(parsed.p || 0), c: Number(parsed.c || 0), f: Number(parsed.f || 0) };
  await cacheSet(db, key, per);
  return per;
}

async function modelItems(db: Db, userId: string, text: string) {
  const key = hashKey("parse", normalizeText(text));
  const cached = await cacheGet<Array<{ name: string; grams: number }>>(db, key);
  if (cached) return cached;
  await assertCanCall(db, userId);
  let parsed: Array<{ name: string; grams: number }> = [];
  await deepseekChat({
    kind: "parse",
    tools: [PARSE_TOOL],
    toolChoice: { type: "function", function: { name: "parse_foods" } },
    messages: [
      { role: "system", content: "调用 parse_foods。只拆名称和克重，不要估计热量，不要写链接。" },
      { role: "user", content: text },
    ],
    onTool: (_name, args) => {
      const items = Array.isArray(args.items) ? args.items : [];
      parsed = items
        .map((item) => {
          const row = item as { name?: string; grams?: number };
          return { name: String(row.name || ""), grams: Number(row.grams || 0) };
        })
        .filter((item) => item.name && item.grams > 0);
      return "ok";
    },
    onUsage: (usage, kind, status) => recordUsage(db, userId, kind, usage, status),
  });
  await cacheSet(db, key, parsed);
  return parsed;
}

async function resolveNames(db: Db, userId: string, names: Array<{ name: string; grams: number }>, allowModel: boolean) {
  const items: ResolvedItem[] = [];
  const missing: string[] = [];
  for (const row of names) {
    const hit = matchFood(normalizeText(row.name));
    if (hit) {
      const factor = await personalFactorFor(db, userId, row.name);
      items.push(applyPersonalFactor(resolveTableItem({
        food: hit.food, grams: row.grams, gramsEstimated: false, portion: null,
      }), factor));
      continue;
    }
    if (!allowModel) {
      missing.push(row.name);
      continue;
    }
    const per = await estimatePer100(db, userId, row.name);
    if (!per) missing.push(row.name);
    else items.push(resolveModelItem({ name: row.name, grams: row.grams, per100: per }));
  }
  return { items, missing };
}

async function commitExercise(db: Db, user: WellnessUser, day: string, draft: ExerciseDraft, source: string) {
  const saved = await addExercise(db, user, day, {
    activity: draft.activity,
    met: draft.met,
    minutes: draft.minutes,
    kcal: draft.kcal,
    unclassified: draft.unclassified,
  });
  if (saved.need_weight) {
    await setPending(db, user.id, { kind: "exercise", ...draft, day, source });
    return {
      reply: "这次运动没写消耗。估算需要体重（公斤）。回一个数字，或回「跳过」。跳过就按 58 公斤，并标估算。",
      intent: "ask_weight",
      cards: [] as ChatCard[],
      model: "rules",
      user: saved.user,
    };
  }
  const detail = saved.estimated
    ? `按 ${saved.user.weightKg || 58} 公斤、MET ${draft.met} 估算。${draft.unclassified ? "这项不在简表里，按未分类 4.0。" : ""}`
    : "";
  return {
    reply: exerciseReply(draft.activity, draft.minutes, saved.kcal, saved.estimated, detail),
    intent: "exercise",
    cards: [
      {
        type: "exercise",
        entry_id: saved.id,
        estimated: saved.estimated,
        kcal: saved.kcal,
        minutes: draft.minutes,
        text: draft.activity,
      },
    ],
    model: "rules",
    user: saved.user,
  };
}

/** Medical / consult / removed-feature gates are also available to the router. */
export function wellnessGate(text: string): HandlerResult | null {
  if (isMedical(text)) return { reply: medicalReply(text), intent: "medical", cards: [], model: "rules" };
  if (isRemovedAudio(text)) return { reply: REMOVED_AUDIO_REPLY, intent: "removed_feature", cards: [], model: "rules" };
  if (isConsult(text)) return { reply: CONSULT_REPLY, intent: "consult_blocked", cards: [], model: "rules" };
  return null;
}

export async function handleWellnessChat(
  { db }: WellnessDeps,
  user: WellnessUser,
  text: string,
  day?: string,
): Promise<HandlerResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new HttpError(400, "empty", "先写一句话");
  if (trimmed.length > 2000) throw new HttpError(400, "too_long", "请缩短一点再发");
  const targetDay = day || todayShanghai();

  if (user.pending) {
    const pending = user.pending as ExerciseDraft & { day: string; source?: string };
    const compact = trimmed.replace(/\s+/g, "");
    const skip = /^(跳过|不用了|用默认|不知道)$/.test(compact);
    const kgMatch = compact.match(/^(\d+(?:\.\d+)?)(kg|公斤|千克)?$/);
    if (skip || kgMatch) {
      const kg = kgMatch ? Number(kgMatch[1]) : undefined;
      if (kgMatch && (kg! < 30 || kg! > 250)) throw new HttpError(400, "weight", "体重请填 30 到 250 公斤");
      await setPending(db, user.id, null);
      const fresh = await loadWellnessUser(db, user.id);
      const saved = await addExercise(db, fresh, pending.day || targetDay, {
        activity: pending.activity,
        met: pending.met,
        minutes: pending.minutes,
        kcal: pending.kcal,
        unclassified: pending.unclassified,
        weightKg: kg,
        skipWeight: skip,
      });
      if (saved.need_weight) throw new HttpError(400, "weight", "还是缺体重");
      const detail = saved.estimated ? `按 ${kg || 58} 公斤、MET ${pending.met} 估算。` : "";
      return finish(db, fresh, pending.day || targetDay, trimmed, {
        reply: exerciseReply(pending.activity, pending.minutes, saved.kcal, saved.estimated, detail),
        intent: "exercise",
        cards: [{ type: "exercise", entry_id: saved.id, estimated: saved.estimated, kcal: saved.kcal, minutes: pending.minutes, text: pending.activity }],
        model: "rules",
      });
    }
  }

  const parsed = parseLog(trimmed);
  const logging = parsed.kind !== "none" && (looksLikeLog(trimmed) || parsed.kind === "clarify");
  if (logging) {
    const cards: ChatCard[] = [];
    const replies: string[] = [];
    let current = user;
    if (parsed.kind === "clarify") {
      return finish(db, user, targetDay, trimmed, { reply: parsed.text, intent: "clarify", cards: [], model: "rules" });
    }
    if (parsed.kind === "sleep" || (parsed.kind === "intake" && parsed.sleep)) {
      const draft = parsed.kind === "sleep" ? parsed.sleep : parsed.sleep!;
      const saved = await addSleep(db, user.id, targetDay, draft);
      cards.push({ type: "sleep", entry_id: saved.id, minutes: saved.minutes ?? undefined });
      replies.push(formatSleep(saved));
    }
    if (parsed.kind === "exercise" || (parsed.kind === "intake" && parsed.exercise)) {
      const draft = parsed.kind === "exercise" ? parsed.exercise : parsed.exercise!;
      const saved = await commitExercise(db, current, targetDay, draft, trimmed);
      current = saved.user;
      if (saved.intent === "ask_weight") {
        return finish(db, current, targetDay, trimmed, { reply: saved.reply, intent: saved.intent, cards: saved.cards, model: "rules" });
      }
      replies.push(saved.reply);
      cards.push(...saved.cards);
    }
    if (parsed.kind === "intake") {
      let items = parsed.intake.items;
      let missing = parsed.intake.unknown;
      if ((!items.length && missing.length) || missing.length) {
        if (env.deepseekKey) {
          try {
            if (!items.length) {
              const fromModel = await modelItems(db, user.id, trimmed);
              const resolved = await resolveNames(db, user.id, fromModel, true);
              items = resolved.items;
              missing = resolved.missing;
            } else {
              const resolved = await resolveNames(db, user.id, missing.map((name) => ({ name, grams: 100 })), true);
              items = items.concat(resolved.items);
              missing = resolved.missing;
            }
          } catch (error) {
            if (error instanceof HttpError) throw error;
            if (error instanceof LlmError) missing = missing.length ? missing : parsed.intake.unknown;
            else throw error;
          }
        }
      }
      if (items.length) {
        const plainWater = items.every((item) => item.food_id && FOOD_BY_ID.get(item.food_id)?.flag === "water" && item.kcal === 0);
        if (plainWater) {
          const ml = items.reduce((sum, item) => sum + item.water_ml, 0);
          const id = await insertEntry(db, {
            userId: user.id, day: targetDay, kind: "water", sourceText: trimmed, water_ml: ml,
            detail: { ml, beverage: items.map((item) => item.name).join("、"), counts: true },
          });
          replies.push(`已记入今天喝水。\n${items.map((item) => `${item.name} ${item.water_ml} ml`).join("、")}`);
          cards.push({ type: "water", entry_id: id, water_ml: ml });
        } else {
          const saved = await saveFoodEntry(db, user.id, targetDay, trimmed, items);
          const lines = items.map((item) => {
            const how = item.lookup === "table" ? "查表" : "模型估算";
            const gram = item.grams_estimated ? `约 ${item.grams} g` : `${item.grams} g`;
            return `${item.name} ${gram} · ${how}`;
          });
          replies.push(
            [
              "已记入今天饮食。",
              ...lines,
              `合计约 ${saved.totals.kcal} kcal · 估算`,
              `蛋白质 ${saved.totals.protein_g} g · 碳水 ${saved.totals.carb_g} g · 脂肪 ${saved.totals.fat_g} g`,
              ...foodNote(items),
            ].join("\n"),
          );
          cards.push({
            type: "food",
            entry_id: saved.id,
            estimated: true,
            kcal: saved.totals.kcal,
            kcal_low: items.reduce((sum, item) => sum + item.kcal_low, 0),
            kcal_high: items.reduce((sum, item) => sum + item.kcal_high, 0),
            confidence: Math.min(...items.map((item) => item.confidence)),
            protein_g: saved.totals.protein_g,
            carb_g: saved.totals.carb_g,
            fat_g: saved.totals.fat_g,
            water_ml: saved.totals.water_ml,
            items,
          });
        }
      }
      if (missing.length) {
        replies.push(`这些没在表里对上，也没有估成热量：${missing.join("、")}。可以说得更具体，或直接写克重。`);
      }
      if (parsed.intake.clarify) replies.push(parsed.intake.clarify);
    }
    if (replies.length) {
      return finish(db, current, targetDay, trimmed, {
        reply: replies.join("\n\n"), intent: "log", cards,
        model: env.deepseekKey ? "deepseek" : "rules",
      });
    }
  }

  return finish(db, user, targetDay, trimmed, {
    reply: RECORD_ONLY_REPLY, intent: "clarify", cards: [], model: "rules",
  });
}
