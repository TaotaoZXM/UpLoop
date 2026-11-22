/**
 * WP2.6: unified intent router. Order is fixed by PRD §3:
 *   1 medical/emergency (unconditional) -> 2 consent/onboarding/quota
 *   -> 3 pending weight -> 4 rules -> 5 model fallback
 *   -> 6 multi-intent handlers in order -> 7 messages + metrics.
 * No amount / usage field is ever returned to the application surface (F-S5).
 */
import { randomUUID } from "node:crypto";
import { json, nowMsIso, readJson } from "../db/pool.js";
import { env } from "../env.js";
import { consentRequired, HttpError, onboardingRequired } from "../errors.js";
import { createExpense } from "../ledger/routes.js";
import { loadProfile } from "../profile/routes.js";
import { generateReport } from "../report/routes.js";
import { checkRoutine, createRoutine, findRoutineByTitle } from "../routine/routes.js";
import { startFocus } from "../focus/routes.js";
import type { AppDeps } from "../types.js";
import { monthUsage, QUOTA_MESSAGE, recordMetric, recordUsage } from "../usage/quota.js";
import { deepseekChat } from "../wellness/logic/llm.js";
import { todayShanghai } from "../wellness/logic/time.js";
import { loadWellnessUser, saveMessage } from "../wellness/repo.js";
import { handleWellnessChat, wellnessGate, type ChatCard, type HandlerResult } from "../wellness/chat.js";
import { validateTaskLimits, type AppState } from "../state/routes.js";
import {
  INTENT_TOOL,
  detectIntents,
  parseExpense,
  parseFocusSeconds,
  parseModelIntent,
  parseRoutineTitle,
  parseTaskTitle,
  type Intent,
} from "./intent.js";

export type ChatResponse = {
  reply: string;
  cards: ChatCard[];
  intent: string;
  day: string;
  blocked?: boolean;
};

export type ChatInput = {
  userId: string;
  text: string;
  day?: string;
  source?: string;
  persistMessages?: boolean;
};

const clarifyReply = () => env.wellnessEnabled
  ? "我在的。可以直接说吃了什么、运动多久、喝了多少水、花了多少钱，或者说「现在做什么」。"
  : "我在的。可以添加任务、完成日常清单，或者问「现在做什么」。";

async function classifyWithModel(db: AppDeps["db"], userId: string, text: string): Promise<Intent> {
  if (!env.deepseekKey) return "clarify";
  let classified: Intent = "clarify";
  try {
    await deepseekChat({
      kind: "intent",
      tools: [INTENT_TOOL],
      toolChoice: { type: "function", function: { name: "classify_intent" } },
      messages: [
        { role: "system", content: "调用 classify_intent，只输出意图枚举，不要输出数字或建议。" },
        { role: "user", content: text },
      ],
      onTool: (_name, args) => {
        classified = parseModelIntent(args);
        return "ok";
      },
      onUsage: (usage, kind, status) => recordUsage(db, userId, kind, usage, status),
    });
  } catch {
    return "clarify";
  }
  return classified;
}

async function addTaskToState(db: AppDeps["db"], userId: string, text: string): Promise<HandlerResult> {
  const title = parseTaskTitle(text);
  if (!title) {
    return { reply: "想加哪件事？可以说「加任务：给客户回邮件」。", intent: "task", cards: [], model: "rules" };
  }
  const row = await db.one<{ state: unknown; updated_at: unknown }>(
    "SELECT state, updated_at FROM user_app_state WHERE user_id = $1 LIMIT 1",
    [userId],
  );
  const state = readJson<AppState | null>(row?.state, null) || {
    version: 1, todo: [], done: [], ideas: [], feedback: [], projects: [],
  };
  const todo = Array.isArray(state.todo) ? (state.todo as Record<string, unknown>[]) : [];
  const next = {
    ...state,
    todo: [...todo, { id: randomUUID(), title, difficulty: "easy", priority: "other", project: "未分类", display: "", deadline: "" }],
  } as AppState;
  const limitError = validateTaskLimits(next);
  if (limitError) {
    return { reply: `${limitError}。先一件一件来，也可以先把想法存进灵感池。`, intent: "task", cards: [], model: "rules" };
  }
  const writtenAt = nowMsIso();
  if (row) {
    await db.query(
      "UPDATE user_app_state SET state = $1::jsonb, updated_at = $2::timestamptz WHERE user_id = $3",
      [json(next), writtenAt, userId],
    );
  } else {
    await db.query(
      "INSERT INTO user_app_state (user_id, state, updated_at) VALUES ($1, $2::jsonb, $3::timestamptz)",
      [userId, json(next), writtenAt],
    );
  }
  return { reply: `记下了「${title}」。`, intent: "task", cards: [{ type: "task", text: title }], model: "rules" };
}

async function runHandler(
  deps: AppDeps,
  intent: Intent,
  input: ChatInput,
  day: string,
): Promise<HandlerResult> {
  const { db } = deps;
  const userId = input.userId;
  const text = input.text;

  switch (intent) {
    case "wellness": {
      if (!env.wellnessEnabled) return { reply: "Wellness 已暂停使用，这次没有写入健康记录。已有数据保留。", intent: "wellness_disabled", cards: [], model: "rules" };
      const user = await loadWellnessUser(db, userId);
      return handleWellnessChat({ db }, user, text, day);
    }
    case "expense": {
      const draft = parseExpense(text);
      if (!draft) return { reply: "这笔收支没读到金额，可以说「午饭 32」或「工资到账 8000」。", intent: "expense", cards: [], model: "rules" };
      const expense = await createExpense(db, userId, {
        amount: draft.amount,
        kind: draft.kind,
        day,
        note: draft.note,
        category: draft.category,
        source: input.source === "device" ? "device" : "chat",
      });
      const suffix = draft.category ? ` · ${draft.category}` : "";
      return {
        reply: `记下了这笔${draft.kind === "income" ? "收入" : "开销"} ${expense?.amount} 元${draft.note ? `（${draft.note}）` : ""}${suffix}。`,
        intent: "expense",
        cards: [{ type: "expense", text: `${expense?.amount} 元`, ...(expense ? { entry_id: expense.id } : {}) } as ChatCard],
        model: "rules",
      };
    }
    case "routine": {
      const title = parseRoutineTitle(text);
      if (!title) return { reply: "想勾哪一项 Routine？可以说「routine 护肤」。", intent: "routine", cards: [], model: "rules" };
      const found = await findRoutineByTitle(db, userId, title);
      if (!found) {
        const created = await createRoutine(db, userId, title);
        return { reply: `清单里加了一项「${created.title}」。`, intent: "routine", cards: [], model: "rules" };
      }
      await checkRoutine(db, userId, found.id, day, true);
      return { reply: `「${found.title}」今天勾好了。`, intent: "routine", cards: [{ type: "routine", text: found.title }], model: "rules" };
    }
    case "focus": {
      const seconds = parseFocusSeconds(text);
      if (!seconds) return { reply: "专注先到这里。", intent: "focus", cards: [], model: "rules" };
      const session = await startFocus(db, userId, seconds, null, input.source === "device" ? "device" : "web");
      return {
        reply: `开始了 ${Math.round(session.plannedSec / 60)} 分钟专注。需要停一下随时说。`,
        intent: "focus",
        cards: [{ type: "focus", text: `${Math.round(session.plannedSec / 60)} 分钟`, minutes: Math.round(session.plannedSec / 60) }],
        model: "rules",
      };
    }
    case "report": {
      const report = await generateReport(db, userId, day);
      return {
        reply: report.narrative || "今天先到这里，想写两句的话可以留一篇短日记。",
        intent: "report",
        cards: [{ type: "report", text: report.stats.isEmpty ? "今天还很空" : `完成 ${report.stats.doneCount} 件` }],
        model: env.deepseekKey ? "deepseek" : "rules",
      };
    }
    case "retired": {
      return {
        reply: "现在可以到 Overview 抽一张任务卡，从眼前这叠里挑一件开始。",
        intent: "retired",
        cards: [],
        model: "rules",
      };
    }
    case "task":
      return addTaskToState(db, userId, text);
    default:
      return { reply: clarifyReply(), intent: "clarify", cards: [], model: "rules" };
  }
}

export async function handleChat(deps: AppDeps, input: ChatInput): Promise<ChatResponse> {
  const { db } = deps;
  const text = String(input.text || "").trim();
  if (!text) throw new HttpError(400, "empty", "先写一句话");
  if (text.length > 2000) throw new HttpError(400, "too_long", "请缩短一点再发");
  const day = input.day || todayShanghai();
  const source = input.source || "web";

  const persist = async (result: HandlerResult) => {
    if (input.persistMessages === false) return;
    await saveMessage(db, input.userId, "user", text, day, { source });
    await saveMessage(db, input.userId, "assistant", result.reply, day, {
      intent: result.intent, cards: result.cards, model: result.model, source,
    });
  };

  // 1. Medical / emergency / removed-feature / consult gates come FIRST and are
  //    unaffected by onboarding, consent or quota (PRD §3 / S-W7).
  const gate = wellnessGate(text);
  if (gate) {
    await recordMetric(db, input.userId, gate.intent === "medical" ? "medical_refuse" : gate.intent);
    await persist(gate);
    return { reply: gate.reply, cards: gate.cards, intent: gate.intent, day };
  }

  // 2. Onboarding -> cloud consent -> quota.
  const profile = await loadProfile(db, input.userId);
  if (!profile?.onboarded_at) throw onboardingRequired();
  if (profile.cloud_consent !== true) throw consentRequired();
  const usage = await monthUsage(db, input.userId);
  if (usage.blocked) {
    const result: HandlerResult = { reply: QUOTA_MESSAGE, intent: "quota", cards: [], model: "rules", blocked: true };
    await recordMetric(db, input.userId, "quota_block");
    await persist(result);
    return { reply: result.reply, cards: [], intent: "quota", day, blocked: true };
  }

  // 3. Pending weight is handled inside handleWellnessChat.
  // 4/5. Rules first; only an unclassified sentence may reach the model.
  let intents = detectIntents(text);
  if (intents.length === 1 && intents[0] === "clarify") {
    const modelIntent = await classifyWithModel(db, input.userId, text);
    if (modelIntent !== "clarify") intents = [modelIntent];
  }

  // 6. Execute all handlers; replies join, cards merge.
  const replies: string[] = [];
  const cards: ChatCard[] = [];
  const usedIntents: string[] = [];
  for (const intent of intents) {
    const result = await runHandler(deps, intent, input, day);
    if (result.reply) replies.push(result.reply);
    cards.push(...result.cards);
    usedIntents.push(result.intent);
  }
  const result: HandlerResult = {
    reply: replies.join("\n\n") || clarifyReply(),
    cards,
    intent: usedIntents.join("+") || "clarify",
    model: "rules",
  };
  await persist(result);
  await recordMetric(db, input.userId, "chat", { intents: usedIntents, source });
  return { reply: result.reply, cards, intent: result.intent, day };
}

