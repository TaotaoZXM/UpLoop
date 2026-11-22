/**
 * WP2.8 / M01-F5: AI daily report + diary. Q9: generate on first open of the
 * review screen, no in-process setInterval. The model receives only `stats` and
 * a handful of titles — never raw conversation text — and may not give diet,
 * nutrition, weight or training advice. Model failure degrades to a template.
 */
import { Router } from "express";
import { readJson } from "../db/pool.js";
import { asyncRoute, dayOf } from "../http.js";
import { authUser } from "../auth/session.js";
import { HttpError } from "../errors.js";
import { env } from "../env.js";
import { assertCanCall, recordUsage } from "../usage/quota.js";
import { deepseekChat } from "../wellness/logic/llm.js";
import { shanghaiParts, todayShanghai } from "../wellness/logic/time.js";
import { daySummary } from "../wellness/repo.js";
import { isMemoryEnabled } from "../memory/projection.js";
import type { AppDeps } from "../types.js";
import type { AppState } from "../state/routes.js";

export type ReportStats = {
  wellnessIncluded?: boolean;
  day: string;
  doneCount: number;
  doneTitles: string[];
  reviewCount: number;
  ideaCount: number;
  feedbackCount: number;
  focusMinutes: number;
  routineDoneCount: number;
  routineTitles?: string[];
  expenseTotalYuan: string;
  wellness: {
    kcal: number;
    waterMl: number;
    sleepMin: number;
    exerciseMin: number;
  };
  entryCount: number;
  isEmpty: boolean;
};

export function recordDay(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "number" || /^\d{12,}$/.test(String(value)) ? Number(value) : String(value);
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : todayShanghai(date);
}

export async function computeReportStats(db: NonNullable<AppDeps["db"]>, userId: string, day: string): Promise<ReportStats> {
  const stateRow = await db.one<{ state: unknown }>("SELECT state FROM user_app_state WHERE user_id = $1 LIMIT 1", [userId]);
  const state = readJson<AppState | null>(stateRow?.state, null);
  const done = (Array.isArray(state?.done) ? (state?.done as Array<Record<string, unknown>>) : [])
    .filter(item => recordDay(item.completed) === day);
  const ideas = (Array.isArray(state?.ideas) ? (state!.ideas as Array<Record<string, unknown>>) : [])
    .filter(item => recordDay(item.createdAt) === day);
  // Suspended module: preserve stored records, exclude them from current reports.
  const feedback = env.taskReflectionEnabled && Array.isArray(state?.feedback) ? state!.feedback : [];
  const wellness = env.wellnessEnabled ? await daySummary(db, userId, day) : null;
  const expense = await db.one<{ cents: number }>(
    "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE user_id = $1 AND day = $2 AND deleted_at IS NULL AND kind = 'expense'",
    [userId, day],
  );
  const focus = await db.one<{ seconds: number }>(
    `SELECT COALESCE(SUM(elapsed_sec), 0) AS seconds FROM focus_sessions
     WHERE user_id = $1 AND status = 'done' AND (ended_at AT TIME ZONE 'Asia/Shanghai')::date = $2`,
    [userId, day],
  );
  const routine = await db.one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM routine_checks c
     JOIN routines r ON r.id = c.routine_id WHERE r.user_id = $1 AND c.day = $2`,
    [userId, day],
  );
  const routineRows = await db.rows<{ title: string }>(
    `SELECT r.title FROM routine_checks c JOIN routines r ON r.id = c.routine_id
     WHERE r.user_id = $1 AND c.day = $2 ORDER BY c.checked_at ASC`,
    [userId, day],
  );
  const doneTitles = done.map((item) => String(item.title || "")).filter(Boolean).slice(0, 8);
  const entryCount = wellness?.entries.length || 0;
  const isEmpty = done.length === 0 && ideas.length === 0 && feedback.length === 0
    && entryCount === 0 && Number(routine?.count || 0) === 0 && Number(focus?.seconds || 0) === 0;
  return {
    wellnessIncluded: env.wellnessEnabled,
    day,
    doneCount: done.length,
    doneTitles,
    reviewCount: env.taskReflectionEnabled ? done.filter((item) => Boolean(item.reviewNote)).length : 0,
    ideaCount: ideas.length,
    feedbackCount: feedback.length,
    focusMinutes: Math.round(Number(focus?.seconds || 0) / 60),
    routineDoneCount: Number(routine?.count || 0),
    routineTitles: routineRows.map(item => item.title).slice(0, 50),
    expenseTotalYuan: (Number(expense?.cents || 0) / 100).toFixed(2),
    wellness: {
      kcal: wellness?.summary.kcal || 0,
      waterMl: wellness?.summary.water_ml || 0,
      sleepMin: wellness?.summary.sleep_min || 0,
      exerciseMin: wellness?.summary.exercise_min || 0,
    },
    entryCount,
    isEmpty,
  };
}

function templateNarrative(stats: ReportStats) {
  const when = stats.day && stats.day !== todayShanghai() ? "这一天" : "今天";
  if (stats.isEmpty) return [`${when}还没有留下记录。`, "从最小的一件开始，做完它，这一天就算数了。"].join("\n");
  const titles = stats.doneTitles.filter(Boolean);
  const [first, second] = titles;
  const lines: string[] = [];
  if (stats.doneCount >= 3) lines.push(`${when}一口气完成了 ${stats.doneCount} 件事。`);
  else if (stats.doneCount === 2) lines.push(`${when}完成了 2 件事，很扎实。`);
  else if (stats.doneCount === 1) lines.push(`${when}把一件事做完了。`);
  else lines.push(`${when}的节奏没有断。`);
  if (second) lines.push(`「${first}」和「${second}」都已经落了地。`);
  else if (first) lines.push(`「${first}」已经落了地。`);
  if (stats.focusMinutes >= 60) lines.push(`专注了 ${Math.floor(stats.focusMinutes / 60)} 小时${stats.focusMinutes % 60 ? ` ${stats.focusMinutes % 60} 分钟` : ""}，整块的时间最容易出成果。`);
  else if (stats.focusMinutes) lines.push(`专注了 ${stats.focusMinutes} 分钟，心思放在了对的地方。`);
  if (stats.routineDoneCount) lines.push(`Checklist 勾掉了 ${stats.routineDoneCount} 项，日常的节奏稳稳接住了。`);
  if (stats.ideaCount) lines.push(`还留下 ${stats.ideaCount} 个新想法，明天有素材可用。`);
  if (stats.entryCount) lines.push(`也记下了 ${stats.entryCount} 条健康记录，没有忘了照顾自己。`);
  if (lines.length === 1) lines.push("哪怕记录不多，也是在认真过日子。");
  return [...lines.slice(0, 4), "给自己一点掌声。"].join("\n");
}

/** No advice, no judgement, no raw text. Only aggregate stats reach the model. */
async function writeNarrative(db: AppDeps["db"], userId: string, stats: ReportStats) {
  const fallback = templateNarrative(stats);
  const { wellness, entryCount, expenseTotalYuan, ...activeStats } = stats;
  if (!env.deepseekKey || stats.isEmpty) return fallback;
  try {
    await assertCanCall(db, userId);
    const text = await deepseekChat({
      kind: "report",
      messages: [
        {
          role: "system",
          content: "你是用户的记录搭档，用中文写一段今日回顾，像朋友在认真夸他。严格按这个格式输出：第一行是不超过 16 个字的标题，带一个具体数字，或用「」引用 doneTitles 里的任务原名；接着 2 到 3 行，每行只写一句、不超过 30 个字，每句单独占一行；最后一行是一句具体的肯定，轻轻指向明天。每行都以句号结尾，行与行之间只用换行分隔，不要空行、列表、序号、加粗或表情符号。内容只用给出的数字和 doneTitles 原标题，不编造未给出的数字或事件。语气温暖、生动、有力量，不说教、不批评、不评价体重或摄入，不给减脂、营养、训练处方类建议，不提额度或费用。when 是称呼这一天的词（今天或这一天），请照用；标题和正文都不要出现具体日期。每个任务名都用「」包起来。最后一行必须是肯定的话（例如夸奖加一句指向明天），统计性的句子不算。如果当天几乎没有记录，就写两行，鼓励从最小的一步开始。",
        },
        { role: "user", content: JSON.stringify({ ...(env.wellnessEnabled ? stats : activeStats), day: undefined, when: stats.day && stats.day !== todayShanghai() ? "这一天" : "今天" }) },
      ],
      onTool: () => "",
      onUsage: (usage, kind, status) => recordUsage(db, userId, kind, usage, status),
    });
    const clean = text.trim().slice(0, 600);
    return clean || fallback;
  } catch {
    return fallback;
  }
}

export async function generateReport(db: AppDeps["db"], userId: string, day: string) {
  const stats = await computeReportStats(db, userId, day);
  const narrative = await writeNarrative(db, userId, stats);
  const rows = await db.rows<{ diary: string | null }>(
    `INSERT INTO daily_reports (user_id, day, stats, narrative) VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (user_id, day) ${env.wellnessEnabled ? "DO UPDATE SET stats = EXCLUDED.stats, narrative = EXCLUDED.narrative" : "DO NOTHING"}
     RETURNING diary`,
    [userId, day, JSON.stringify(stats), narrative],
  );
  const saved = rows[0] || (!env.wellnessEnabled ? await db.one<{ diary: string | null }>("SELECT diary FROM daily_reports WHERE user_id = $1 AND day = $2", [userId, day]) : null);
  return { stats, narrative, diary: saved?.diary || null };
}

export function createReportRouter({ db }: AppDeps) {
  const router = Router();

  router.get(
    "/report",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const day = dayOf(req.query.day);
      const row = await db.one<{ stats: unknown; narrative: string | null; diary: string | null }>(
        "SELECT stats, narrative, diary FROM daily_reports WHERE user_id = $1 AND day = $2",
        [user.id, day],
      );
      if (row && env.wellnessEnabled && readJson<ReportStats>(row.stats, {} as ReportStats).wellnessIncluded !== false) {
        return res.json({
          day,
          stats: readJson<ReportStats>(row.stats, {} as ReportStats),
          narrative: row.narrative,
          diary: row.diary,
          generated: true,
          memoryEnabled: isMemoryEnabled(),
        });
      }
      const report = await generateReport(db, user.id, day);
      return res.json({ day, ...report, generated: true });
    }),
  );

  router.post(
    "/report",
    asyncRoute(async (req, res) => {
      const day = dayOf(req.body?.day);
      return res.json({ day, ...(await generateReport(db, authUser(req).id, day)) });
    }),
  );

  router.patch(
    "/report/diary",
    asyncRoute(async (req, res) => {
      const day = dayOf(req.body?.day);
      const diary = String(req.body?.diary || "").slice(0, 500);
      const row = await db.one<{ stats: unknown; narrative: string | null }>(
        "SELECT stats, narrative FROM daily_reports WHERE user_id = $1 AND day = $2",
        [authUser(req).id, day],
      );
      if (!row) throw new HttpError(404, "not_found", "先生成今天的战报");
      await db.query(
        "UPDATE daily_reports SET diary = $3 WHERE user_id = $1 AND day = $2",
        [authUser(req).id, day, diary],
      );
      return res.json({ ok: true, diary });
    }),
  );

  /** M01-F5: in-app reminder only (no push). */
  router.get(
    "/report/reminder",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const hour = shanghaiParts().hour;
      const row = await db.one<{ day: string }>(
        "SELECT day FROM daily_reports WHERE user_id = $1 AND day = $2",
        [user.id, todayShanghai()],
      );
      return res.json({ shouldRemind: hour >= 21 && !row });
    }),
  );

  return router;
}
