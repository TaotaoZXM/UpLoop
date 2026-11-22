/**
 * WP2.3 / F-S5: ¥50 account-level monthly cap, warn at 80%, hard stop at 100%.
 * The application surface never exposes RMB amounts. Only the admin endpoint may.
 * `assertCanCall` keeps fitness-helper's "estimate before calling" behaviour.
 * Manual Wellness records are NOT affected by the cap (PRD S-W9).
 */
import { randomUUID } from "node:crypto";
import { json, readJson, type Db } from "../db/pool.js";
import { LIMIT_YUAN, LI_PER_YUAN, WARN_YUAN, env } from "../env.js";
import { quotaExceeded } from "../errors.js";
import { costLi } from "../wellness/logic/pricing.js";
import { monthShanghai, todayShanghai } from "../wellness/logic/time.js";
import type { TokenUsage } from "../wellness/logic/llm.js";

export const QUOTA_MESSAGE = "本月额度已用完，对话已暂停";

export type MonthUsage = {
  month: string;
  li: number;
  tokens: number;
  calls: number;
  warn: boolean;
  blocked: boolean;
};

export async function monthUsage(db: Db, userId: string, month = monthShanghai()): Promise<MonthUsage> {
  const row = await db.one<{ li: number; tokens: number; calls: number }>(
    `SELECT COALESCE(SUM(cost_li), 0) AS li,
            COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
            COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS calls
     FROM usage_calls WHERE user_id = $1 AND month = $2`,
    [userId, month],
  );
  const li = Number(row?.li || 0);
  return {
    month,
    li,
    tokens: Number(row?.tokens || 0),
    calls: Number(row?.calls || 0),
    warn: li >= WARN_YUAN * LI_PER_YUAN && li < LIMIT_YUAN * LI_PER_YUAN,
    blocked: li >= LIMIT_YUAN * LI_PER_YUAN,
  };
}

export async function estimateNextLi(db: Db, userId: string) {
  try {
    const recent = await db.rows<{ cost_li: number }>(
      "SELECT cost_li FROM usage_calls WHERE user_id = $1 AND status = 'ok' ORDER BY created_at DESC LIMIT 10",
      [userId],
    );
    if (!recent.length) return 80;
    const avg = recent.reduce((sum, row) => sum + Number(row.cost_li), 0) / recent.length;
    return Math.min(300, Math.max(20, Math.round(avg)));
  } catch {
    return 500;
  }
}

export async function assertCanCall(db: Db, userId: string) {
  const usage = await monthUsage(db, userId);
  const estimate = await estimateNextLi(db, userId);
  if (usage.li >= LIMIT_YUAN * LI_PER_YUAN || usage.li + estimate >= LIMIT_YUAN * LI_PER_YUAN) {
    await recordMetric(db, userId, "quota_block");
    throw quotaExceeded();
  }
}

export async function recordUsage(
  db: Db,
  userId: string,
  kind: string,
  usage: TokenUsage,
  status: "ok" | "error" | "timeout",
) {
  const at = new Date();
  const cost = status === "ok"
    ? costLi({ cached: usage.cached, miss: usage.miss, completion: usage.completion, at })
    : 0;
  await db.query(
    `INSERT INTO usage_calls
       (id, user_id, created_at, month, day, kind, model, prompt_tokens, completion_tokens,
        cached_tokens, miss_tokens, peak, cost_li, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      randomUUID(), userId, at.toISOString(), monthShanghai(at), todayShanghai(at), kind,
      env.deepseekModel, usage.prompt, usage.completion, usage.cached, usage.miss,
      usage.peak, cost, status,
    ],
  );
}

export async function recordMetric(db: Db, userId: string | null, kind: string, detail?: unknown) {
  await db.query(
    "INSERT INTO metric_events (user_id, created_at, day, kind, detail) VALUES ($1, now(), $2, $3, $4::jsonb)",
    [userId, todayShanghai(), kind, detail === undefined ? null : json(detail)],
  );
}

export async function cacheGet<T>(db: Db, key: string): Promise<T | undefined> {
  const row = await db.one<{ result: unknown }>("SELECT result FROM parse_cache WHERE cache_key = $1", [key]);
  if (!row) return undefined;
  return readJson<T | undefined>(row.result, undefined);
}

export async function cacheSet(db: Db, key: string, value: unknown) {
  await db.query(
    `INSERT INTO parse_cache (cache_key, result, created_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (cache_key) DO UPDATE SET result = EXCLUDED.result`,
    [key, json(value)],
  );
}

/** Admin-only (§6: token/cost is back-office only). Never mount this on a user route. */
export async function adminUsage(db: Db, month = monthShanghai()) {
  const rows = await db.rows<{ user_id: string; li: number; calls: number }>(
    `SELECT user_id, COALESCE(SUM(cost_li), 0) AS li, COUNT(*) AS calls
     FROM usage_calls WHERE month = $1 GROUP BY user_id ORDER BY li DESC`,
    [month],
  );
  return {
    month,
    limitYuan: LIMIT_YUAN,
    warnYuan: WARN_YUAN,
    rows: rows.map((row) => ({
      userId: row.user_id,
      yuan: Math.round(Number(row.li)) / LI_PER_YUAN,
      calls: Number(row.calls),
    })),
  };
}
