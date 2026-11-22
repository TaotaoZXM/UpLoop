/**
 * WP2.6 / D1.9: rules first, model fallback. All the routing regexes live here
 * in one place so they can be unit-tested independently of the handlers.
 * The model is only asked for an intent enum — never for a number.
 */
import { inferCategory, type ExpenseKind } from "../ledger/routes.js";
import { looksLikeLog, normalizeText, parseLog } from "../wellness/logic/parse.js";
import { isConsult, isMedical, isRemovedAudio } from "../wellness/logic/rules.js";

export type Intent =
  | "medical"
  | "consult"
  | "removed_feature"
  | "wellness"
  | "expense"
  | "routine"
  | "focus"
  | "report"
  | "task"
  | "retired"
  | "clarify";

/** Writes first. The old energy recommendation is not an executable intent. */
const EXECUTION_ORDER: Intent[] = [
  "wellness", "expense", "routine", "focus", "report", "task",
];

const EXPENSE_RE = /(?:花了|花掉|花|买了|买|付了|支付|消费|支出|开销|充值|记一笔|记账)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:块钱|块|元|人民币|rmb|¥|￥)?/i;
const EXPENSE_SYMBOL_RE = /[¥￥]\s*(\d+(?:\.\d{1,2})?)/;
const INCOME_RE = /(?:工资|薪水|奖金|兼职|报销|理财收益|收入|到账|收款|收到)(?:[^\d，,。；;\n]{0,12})[¥￥]?\s*(\d+(?:\.\d{1,2})?)(?:\s*(?:元|块钱|块|人民币))?(?=$|[\s，,。；;！!])/;
const SHORT_EXPENSE_RE = /(?:早餐|午饭|午餐|晚饭|晚餐|外卖|咖啡|奶茶|打车|地铁|公交|购物|停车)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)(?:\s*(?:元|块钱|块))?(?=$|[\s，,。；;！!])/;
const EXPENSE_BARE_RE = /\d+(?:\.\d{1,2})?\s*(?:块钱|块|元)(?!\s*(?:钱)?\s*(?:的|一斤|每))/;
const RETIRED_RECOMMEND_RE = /现在做什么|今天能做点什么|现在干点什么|做什么好|轻启动|推荐.{0,4}任务|给我推.{0,4}任务|今天先做|挑.{0,3}件/;
const TASK_RE = /加(?:个|一个|条)?任务|新建任务|记(?:一个|下|条)?任务|添加任务|新任务|加个待办|加待办/;
const FOCUS_RE = /专注|番茄钟?|倒计时|开始计时|结束专注|暂停专注/;
const ROUTINE_RE = /routine|日常清单|打卡|勾一下|勾了|完成了护肤|睡前清单/i;
const REPORT_RE = /战报|复盘|日报|今天做了什么|写日记|日记|回顾一下/;

export function detectIntents(text: string): Intent[] {
  const raw = text.trim();
  // Medical/emergency is FIRST and unaffected by onboarding, consent or quota.
  if (isMedical(raw)) return ["medical"];
  if (isRemovedAudio(raw)) return ["removed_feature"];
  if (isConsult(raw)) return ["consult"];

  const t = normalizeText(raw);
  const hit = new Set<Intent>();
  const parsed = parseLog(raw);
  if (parsed.kind !== "none" && (looksLikeLog(raw) || parsed.kind === "clarify")) {
    hit.add("wellness");
  }
  if (parseExpense(t) || EXPENSE_BARE_RE.test(t)) hit.add("expense");
  if (ROUTINE_RE.test(t)) hit.add("routine");
  if (FOCUS_RE.test(t)) hit.add("focus");
  if (REPORT_RE.test(t)) hit.add("report");
  if (RETIRED_RECOMMEND_RE.test(t)) hit.add("retired");
  if (TASK_RE.test(t)) hit.add("task");

  const ordered = EXECUTION_ORDER.filter((intent) => hit.has(intent));
  // "专注 25 分钟" looks like a duration but is not a Wellness log: parseLog() already
  // returns `none`, so no extra exclusion is needed here.
  // A sentence that also writes a record does not also answer the retired picker.
  if (ordered.length) return ordered;
  if (hit.has("retired")) return ["retired"];
  return ["clarify"];
}

export type ExpenseDraft = {
  kind: ExpenseKind;
  amount: number;
  note: string;
  category: string | null;
  spentAt?: string;
};

export function parseExpense(text: string): ExpenseDraft | null {
  // Restrict parsing to one clause so an earlier meal duration/weight is not
  // mistaken for the amount in a later financial clause.
  const clause = text.split(/[，,。;；!！\n]/).find((part) =>
    INCOME_RE.test(part) || EXPENSE_RE.test(part) || EXPENSE_SYMBOL_RE.test(part) || SHORT_EXPENSE_RE.test(part));
  if (!clause) return null;
  const explicitExpense = EXPENSE_RE.exec(clause);
  const income = explicitExpense ? null : INCOME_RE.exec(clause);
  const matched = income || explicitExpense || EXPENSE_SYMBOL_RE.exec(clause) || SHORT_EXPENSE_RE.exec(clause);
  if (!matched) return null;
  const amount = Number(matched[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const kind: ExpenseKind = income ? "income" : "expense";
  // Keep the category cue (e.g. 工资 / 午饭) when the match includes the title.
  const preserveTitle = Boolean(income || (!explicitExpense && !EXPENSE_SYMBOL_RE.test(clause)));
  let note = clause
    .replace(preserveTitle ? matched[1] : matched[0], "")
    .replace(/\s*(?:元|块钱|块|人民币)\s*$/, "")
    .replace(/[，,。;；!！\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  note = note.replace(/^(今天|刚才|刚刚|我|帮我|请|顺便|还有|然后)\s*/g, "").trim();
  const category = kind === "income"
    ? /工资|薪水|奖金/.test(clause) ? "工资"
      : /兼职/.test(clause) ? "兼职"
        : /报销/.test(clause) ? "报销"
          : /理财/.test(clause) ? "理财" : null
    : inferCategory(note);
  return { kind, amount, note, category };
}

export function parseTaskTitle(text: string) {
  const matched = /(?:加|新增|新建|记|添加)(?:个|一个|条)?(?:任务|待办)[:：\s]*(.+)/.exec(text)
    || /(?:任务|待办)[:：]\s*(.+)/.exec(text);
  if (!matched) return null;
  const title = matched[1].replace(/[，,。;；!！\n].*$/, "").trim().slice(0, 80);
  return title || null;
}

export function parseFocusSeconds(text: string) {
  if (/结束专注|完成专注|停止专注/.test(text)) return 0;
  const minutes = /(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/i.exec(text);
  if (minutes) return Math.round(Number(minutes[1]) * 60);
  const hours = /(\d+(?:\.\d+)?)\s*(?:小时|钟头|h)/i.exec(text);
  if (hours) return Math.round(Number(hours[1]) * 3600);
  return 25 * 60;
}

export function parseRoutineTitle(text: string) {
  const matched = /routine\s*[:：]?\s*(.+)/i.exec(text)
    || /(?:完成了|勾了|打卡)\s*(.+)/.exec(text)
    || /(?:加|新增)(?:一项|个)?\s*(?:routine|日常)[:：\s]*(.+)/i.exec(text);
  if (!matched) return null;
  return matched[1].replace(/[，,。;；!！\n].*$/, "").trim().slice(0, 40) || null;
}

/** Optional model fallback: intent enum only, no numbers, no advice. */
export const INTENT_TOOL = {
  type: "function" as const,
  function: {
    name: "classify_intent",
    description: "把用户输入归入一个意图枚举。不要生成任何数字、建议或回复正文。",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: ["wellness", "expense", "routine", "focus", "report", "task", "clarify"],
        },
      },
      required: ["intent"],
    },
  },
};

export function parseModelIntent(args: Record<string, unknown>): Intent {
  const value = String(args.intent || "clarify");
  const allowed: Intent[] = ["wellness", "expense", "routine", "focus", "report", "task", "clarify"];
  return allowed.includes(value as Intent) ? (value as Intent) : "clarify";
}
