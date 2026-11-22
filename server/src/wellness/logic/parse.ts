import { PORTIONS } from "./catalog.js";
import { matchFood, portionFor, resolveTableItem, type ResolvedItem } from "./food.js";

export type ExerciseDraft = {
  activity: string;
  met: number;
  minutes: number;
  kcal: number | null;
  unclassified: boolean;
};

export type SleepDraft = { minutes: number | null; bedtime: string | null; wake: string | null };

export type IntakeDraft = {
  items: ResolvedItem[];
  unknown: string[];
  clarify: string | null;
};

export type Parsed =
  | { kind: "intake"; intake: IntakeDraft; exercise: ExerciseDraft | null; sleep: SleepDraft | null }
  | { kind: "exercise"; exercise: ExerciseDraft }
  | { kind: "sleep"; sleep: SleepDraft }
  | { kind: "clarify"; text: string }
  | { kind: "none" };

const CN: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export function normalizeText(input: string) {
  return input
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/．/g, ".")
    .replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "")
    .trim();
}
function cnNumber(raw: string): number | null {
  if (!raw) return null;
  if (raw === "半") return 0.5;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.startsWith("十")) return 10 + (CN[raw[1]] ?? 0);
  if (raw.includes("十")) {
    const [a, b] = raw.split("十");
    return (CN[a] ?? 1) * 10 + (b ? CN[b] ?? 0 : 0);
  }
  if (raw.length === 1 && CN[raw] !== undefined) return CN[raw];
  return null;
}

const PORTION_UNITS = [
  "小碗",
  "大碗",
  "大杯",
  "小杯",
  "汤匙",
  "茶匙",
  "掌心",
  "罐装",
  "碗",
  "杯",
  "罐",
  "听",
  "瓶",
  "个",
  "只",
  "根",
  "片",
  "块",
  "份",
  "勺",
  "把",
  "串",
  "颗",
  "粒",
  "盒",
  "袋",
  "盘",
  "碟",
  "枚",
  "瓣",
  "桶",
  "条",
  "两",
];

const UNIT_RE = PORTION_UNITS.join("|");
const COUNT_RE = String.raw`(\d+(?:\.\d+)?|[一二两三四五六七八九十半]{1,3})`;
const METRIC_RE = /(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})(千克|公斤|克|g|ml|毫升|升|l|斤|两)/i;

/** Single source of truth for the MET table. http.ts's duplicate was removed (WP2.4). */
export const ACTIVITIES: Array<{ re: RegExp; name: string; met: number; unclassified?: boolean }> = [
  { re: /快走|散步|走路|步行/, name: "散步／快走", met: 3.5 },
  { re: /慢跑|跑步|长跑/, name: "慢跑／跑步", met: 7 },
  { re: /力量|器械|自重|举重|深蹲|卧推|撸铁|抗阻|无氧/, name: "力量训练", met: 5 },
  { re: /骑行|骑车|动感单车|自行车/, name: "骑行", met: 6 },
  { re: /瑜伽|拉伸|普拉提/, name: "瑜伽／拉伸", met: 2.5 },
  { re: /攀岩|抱石|室内攀/, name: "攀岩", met: 8 },
  { re: /游泳/, name: "游泳", met: 4, unclassified: true },
  { re: /打球|篮球|羽毛球|跳绳|椭圆机|划船/, name: "运动", met: 4, unclassified: true },
  { re: /运动|锻炼|训练|健身/, name: "运动", met: 4, unclassified: true },
];
function toGrams(amount: number, unit: string) {
  const u = unit.toLowerCase();
  if (u === "千克" || u === "公斤" || u === "kg") return amount * 1000;
  if (u === "斤") return amount * 500;
  if (u === "两") return amount * 50;
  if (u === "升" || u === "l") return amount * 1000;
  return amount;
}

function stripFillers(clause: string) {
  return clause
    .replace(/^(今天|昨天|前天|早上|中午|晚上|早餐|午餐|晚餐|下午|夜宵|刚刚|刚才|我|帮我|请|记录|记一下|记了|吃了|吃的是|喝了|喝的是|来了|来一份|又)/, "")
    .replace(/^(的|了)/, "");
}

function findPortion(clause: string): { count: number; unit: string } | null {
  const re = new RegExp(`${COUNT_RE}(${UNIT_RE})(半)?`);
  const match = clause.match(re);
  if (!match) return null;
  const count = cnNumber(match[1]);
  if (count === null) return null;
  return { count: count + (match[3] === "半" ? 0.5 : 0), unit: match[2] };
}

function findMetric(clause: string): { grams: number } | null {
  const match = clause.match(METRIC_RE);
  if (!match) return null;
  const amount = cnNumber(match[1]);
  if (amount === null) return null;
  if (match[2] === "两" && /[碗杯瓶个只根片块]/.test(clause.slice(match.index! + match[0].length, match.index! + match[0].length + 1))) {
    return null;
  }
  return { grams: toGrams(amount, match[2]) };
}

function durationMinutes(clause: string): number | null {
  if (/一个半小时|一个半钟头|1\.5小时/.test(clause)) return 90;
  if (/半小时|半个小时|半个钟头/.test(clause)) return 30;
  const hour = clause.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})(?:个)?(?:小时|钟头|h)/i);
  const minute = clause.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})(?:分钟|分|min)/i);
  let total = 0;
  if (hour) {
    const n = cnNumber(hour[1]);
    if (n === null) return null;
    total += Math.round(n * 60);
  }
  if (minute) {
    const n = cnNumber(minute[1]);
    if (n === null) return null;
    total += Math.round(n);
  }
  return total > 0 ? total : null;
}

function userKcal(clause: string): number | null {
  const match = clause.match(/(?:消耗|烧了|热量)\D{0,4}(\d+(?:\.\d+)?)(?:千卡|大卡|kcal)/i);
  if (!match) return null;
  return Math.round(Number(match[1]));
}

function activityOf(clause: string) {
  for (const row of ACTIVITIES) {
    if (row.re.test(clause)) return row;
  }
  return null;
}

export function activityByKey(key: string) {
  return ACTIVITIES.find((row) => row.re.test(key)) || null;
}

function clockIn(fragment: string): string | null {
  const hm = fragment.match(/(\d{1,2})[:：](\d{2})/);
  if (hm) {
    const hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const point = fragment.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})点(半|(\d{1,2}|[一二两三四五六七八九十]{1,2}))?/);
  if (!point) return null;
  let hour = cnNumber(point[1]);
  if (hour === null) return null;
  let minute = 0;
  if (point[2] === "半") minute = 30;
  else if (point[3]) {
    const parsed = cnNumber(point[3]);
    if (parsed === null) return null;
    minute = parsed;
  }
  if (/下午|傍晚|晚上|夜里/.test(fragment) && hour < 12) hour += 12;
  if (/凌晨/.test(fragment) && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseSleep(clause: string): SleepDraft | null {
  if (/睡不着|失眠/.test(clause)) return null;
  // PRD M02-F8 also accepts an equivalent "23:10睡07:10醒" clock pair. The
  // original parser only matched 「我睡了／我醒了」, so this branch was added.
  const span = clause.match(/(\d{1,2}[:：]\d{2})\s*(?:睡|入睡|上床)\D{0,4}(\d{1,2}[:：]\d{2})\s*(?:醒|起床|起)/);
  if (span) {
    const bedtime = clockIn(span[1]);
    const wakeAt = clockIn(span[2]);
    if (bedtime && wakeAt) return { minutes: null, bedtime, wake: wakeAt };
  }
  const wake = /醒了|醒来|起床/.test(clause);
  const bed = /睡了|入睡|我睡|睡觉/.test(clause);
  if (!wake && !bed && !/睡眠/.test(clause)) return null;
  const minutes = durationMinutes(clause);
  const hasDuration = minutes !== null && /小时|钟头|分钟|分|min|h/i.test(clause);
  let bedtime: string | null = null;
  let wakeAt: string | null = null;
  if (bed && wake) {
    const bedPart = clause.split(/醒|起/)[0] || clause;
    bedtime = hasDuration ? null : clockIn(bedPart) || "now";
    wakeAt = clockIn(clause.slice(bedPart.length)) || clockIn(clause) || "now";
  } else if (bed) {
    bedtime = hasDuration ? null : clockIn(clause) || "now";
  } else if (wake) {
    wakeAt = clockIn(clause) || "now";
  }
  if (!hasDuration && !bedtime && !wakeAt) return null;
  return { minutes: hasDuration ? minutes : null, bedtime, wake: wakeAt };
}

const EXERCISE_HINT = /练了|运动了|跑了|走了|游了|打了|爬了|滑了|踢了|跳了|骑了|攀了/;

function unrecognizedActivity(clause: string) {
  const label = clause
    .replace(/今天|昨天|前天|刚才|刚刚|我|帮我|请|记录|记一下|一下/g, "")
    .replace(/(?:一个半小时|半小时|半个小时|半个钟头|\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})(?:个)?(?:小时|钟头|分钟|分|min|h)/gi, "")
    .replace(/练了|运动了|跑了|走了|游了|打了|爬了|滑了|踢了|跳了|骑了|攀了|做了/g, "")
    .replace(/[了的钟]/g, "")
    .trim();
  return label.slice(0, 12) || "未分类运动";
}

function parseExercise(clause: string): ExerciseDraft | "need-duration" | null {
  const activity = activityOf(clause);
  if (!activity) {
    if (/吃|喝|碗|杯|克|毫升/.test(clause) && !/运动|锻炼|训练|攀岩/.test(clause)) return null;
    const minutes = durationMinutes(clause);
    if (!minutes || !EXERCISE_HINT.test(clause)) return null;
    return {
      activity: unrecognizedActivity(clause),
      met: 4,
      minutes,
      kcal: userKcal(clause),
      unclassified: true,
    };
  }
  if (/饮料|蛋白|吃|喝|碗|杯/.test(clause) && matchFood(clause)) return null;
  const minutes = durationMinutes(clause);
  if (!minutes) {
    if (/练了|运动了|跑了|走了|攀岩|抱石/.test(clause)) return "need-duration";
    return null;
  }
  return {
    activity: activity.name,
    met: activity.met,
    minutes,
    kcal: userKcal(clause),
    unclassified: Boolean(activity.unclassified),
  };
}

function parseIntakeClause(clause: string): { item: ResolvedItem | null; unknown: string | null } {
  const cleaned = stripFillers(clause);
  const metric = findMetric(cleaned);
  const portion = findPortion(cleaned);
  let hit = matchFood(cleaned) || matchFood(clause);
  if (!hit && /水/.test(cleaned) && !/果|汽水|奶茶|盐水|糖水|茶/.test(cleaned)) {
    hit = matchFood("白水");
  }
  if (!hit) {
    if (metric && /水|喝/.test(clause) && !/酒|汽水|可乐|奶茶|果汁/.test(clause)) {
      const water = resolveTableItem({        food: matchFood("白水")!.food,
        grams: metric.grams,
        gramsEstimated: false,
        portion: null,
        state: "饮品",
      });
      return { item: water, unknown: null };
    }
    if (/吃|喝|碗|杯|个/.test(clause)) return { item: null, unknown: cleaned || clause };
    return { item: null, unknown: null };
  }
  let grams = 0;
  let estimated = true;
  let portionLabel: string | null = null;
  let state: string | null = null;
  if (metric) {
    grams = metric.grams;
    estimated = false;
    portionLabel = portion ? `${portion.count}${portion.unit}` : null;
  } else if (portion) {
    const row = portionFor(hit.food.id, portion.unit);
    const generic = PORTIONS.find((item) => item.unit === portion.unit);
    const each = row?.grams ?? generic?.grams;
    if (!each) return { item: null, unknown: hit.food.name };
    grams = Math.round(each * portion.count);
    estimated = true;
    portionLabel = `${portion.count}${portion.unit}`;
    state = row?.state ?? null;
  } else {
    const fallback = PORTIONS.find((item) => item.foodId === hit.food.id);
    if (!fallback) return { item: null, unknown: hit.food.name };
    grams = fallback.grams;
    estimated = true;
    portionLabel = `1${fallback.unit}`;
    state = fallback.state;
  }
  if (grams <= 0 || grams > 5000) return { item: null, unknown: hit.food.name };
  return {
    item: resolveTableItem({
      food: hit.food,
      grams,
      gramsEstimated: estimated,
      portion: portionLabel,
      state,
    }),
    unknown: null,
  };
}

function splitClauses(text: string) {
  return text
    .replace(/喝了/g, "，喝了")
    .replace(/吃了/g, "，吃了")
    .split(/[，,、。；;！!\n]|然后|并且|再加|加上|还有|和/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function parseLog(raw: string): Parsed {
  const text = normalizeText(raw);
  if (!text) return { kind: "none" };
  const clauses = splitClauses(text);
  const items: ResolvedItem[] = [];
  const unknown: string[] = [];
  let exercise: ExerciseDraft | null = null;
  let sleep: SleepDraft | null = null;
  let clarify: string | null = null;

  for (const clause of clauses) {
    const slept = parseSleep(clause);
    if (slept) {
      sleep = slept;
      continue;
    }
    const moved = parseExercise(clause);
    if (moved === "need-duration") {
      clarify = "运动记下之前还缺时长。例如：跑步 30 分钟。";
      continue;
    }
    if (moved) {
      exercise = moved;
      continue;
    }
    const intake = parseIntakeClause(clause);
    if (intake.item) items.push(intake.item);
    else if (intake.unknown) unknown.push(intake.unknown);
  }

  if (!items.length && !unknown.length && !exercise && !sleep) {
    if (clarify) return { kind: "clarify", text: clarify };
    return { kind: "none" };
  }  if (items.length || unknown.length) {
    return { kind: "intake", intake: { items, unknown, clarify }, exercise, sleep };
  }
  if (exercise && sleep) {
    return { kind: "intake", intake: { items: [], unknown: [], clarify }, exercise, sleep };
  }
  if (exercise) return { kind: "exercise", exercise };
  if (sleep) return { kind: "sleep", sleep };
  return { kind: "none" };
}

export function looksLikeLog(raw: string) {
  const text = normalizeText(raw);
  if (/[?？]/.test(raw)) return false;
  if (/怎么|为什么|要不要|能不能|出处|依据|有用吗|是不是|可不可以/.test(text)) return false;
  if (/吗$/.test(text)) return false;
  return /吃了|喝了|睡了|睡眠|醒了|起床|跑步|慢跑|散步|力量|骑行|瑜伽|攀岩|抱石|分钟|小时|碗|杯|克|毫升|\d{1,2}[:：]\d{2}睡\d{1,2}[:：]\d{2}醒/.test(text);
}
