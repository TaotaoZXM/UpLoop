/**
 * Local demo server: full API with an in-memory dataset, no PostgreSQL needed.
 * Purpose: browse/verify the P0 UI with real endpoints and seeded data.
 * NOT for production — data lives in this process only and resets on restart.
 *
 *   npm run demo          (login: admin / 12345678, port 8896)
 */
// Type-only import is erased at runtime, so it does NOT trigger env.ts early.
import type { SqlParam } from "../src/db/pool.js";

// env.ts reads process.env at import time, so configure BEFORE importing src/.
process.env.JWT_SECRET = process.env.JWT_SECRET || "demo-jwt-secret-1234567890";
process.env.DEVICE_TOKEN_SECRET = process.env.DEVICE_TOKEN_SECRET || "demo-device-secret-1234567890";
process.env.SERVE_STATIC = process.env.SERVE_STATIC || "1";
process.env.HOST = process.env.HOST || "127.0.0.1";
process.env.PORT = process.env.PORT || "8896";
process.env.BASE_PATH = process.env.BASE_PATH ?? "/task";
process.env.NODE_ENV = "demo";
process.env.ADMIN_USERNAME = "admin";
// No DEEPSEEK_API_KEY on purpose: intent rules and template replies still work.

const bcrypt = (await import("bcryptjs")).default;
const { createApp } = await import("../src/index.js");
const { createFakeDb } = await import("../src/db/pool.js");
const { todayShanghai } = await import("../src/wellness/logic/time.js");
const { SESSION_COOKIE } = await import("../src/auth/session.js");
const { env } = await import("../src/env.js");

const DEMO_EMAIL = "admin";
const DAY = todayShanghai();
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

const userRow: Record<string, unknown> = {
  id: "d1mo0000-0000-4000-8000-00000000d1mo".replace(/o/g, "e"),
  email: DEMO_EMAIL,
  username: "admin",
  email_verified_at: at("08:00"),
  password_hash: bcrypt.hashSync("12345678", 10),
  token_version: 0,
  role: "admin",
};

const profileRow: Record<string, unknown> = {
  user_id: userRow.id,
  gender: "female",
  water_goal_ml: 1700,
  birth_ym: "1995-06",
  weight_kg: null,
  weight_skipped: true,
  cloud_consent: true,
  onboarded_at: at("08:01"),
  pending: null,
  updated_at: at("08:01"),
};

let stateRow: { state: Record<string, unknown>; updated_at: string } | null = {
  state: {
    version: 1,
    todo: [
      { id: "t1", title: "把周报初稿写完", difficulty: "medium", state: "easy" },
      { id: "t2", title: "回两封邮件", difficulty: "easy", state: "easy" },
      { id: "t3", title: "散步十分钟", difficulty: "easy", state: "easy" },
    ],
    done: [
      { id: "d1", title: "晨间拉伸", completed: Date.parse(at("08:00")), reviewNote: "" },
      { id: "d2", title: "给绿萝浇水", completed: Date.parse(at("09:00")), reviewNote: "" },
    ],
    ideas: [
      { id: "i1", text: "周末试试新的攀岩馆", createdAt: at("09:10") },
      { id: "i2", text: "给播客记一集笔记", createdAt: at("10:00") },
    ],
    feedback: [{ id: "f1", text: "今天早上起床没有赖床，做到了" }],
    projects: [],
  },
  updated_at: at("08:10"),
};

type Entry = Record<string, unknown>;
const entries: Entry[] = [
  { id: "w1", kind: "water", water_ml: 500, kcal: 0, occurred_at: at("09:30"), source_text: "早上喝了一大杯", estimated: false, detail: {}, kb_version: 1 },
  { id: "fd1", kind: "food", kcal: 520, kcal_low: 470, kcal_high: 580, protein_g: 28, carb_g: 62, fat_g: 15, occurred_at: at("12:20"), source_text: "中午吃了一碗米饭、150克鸡胸", estimated: true, detail: { items: [{ name: "米饭", grams: 200 }, { name: "鸡胸", grams: 150 }] }, kb_version: 1 },
  { id: "ex1", kind: "exercise", kcal: 480, exercise_min: 60, occurred_at: at("18:40"), source_text: "今天攀岩1小时", estimated: true, detail: { activity: "攀岩" }, kb_version: 1 },
  { id: "sl1", kind: "sleep", sleep_min: 480, occurred_at: at("07:10"), source_text: "23:10睡07:10醒", estimated: false, detail: { bedtime: "23:10", wake: "07:10" }, kb_version: 1 },
];
for (const entry of entries) {
  entry.user_id = userRow.id;
  entry.day = DAY;
  entry.protein_g = entry.protein_g ?? 0;
  entry.carb_g = entry.carb_g ?? 0;
  entry.fat_g = entry.fat_g ?? 0;
  entry.water_ml = entry.water_ml ?? 0;
  entry.sleep_min = entry.sleep_min ?? 0;
  entry.exercise_min = entry.exercise_min ?? 0;
  entry.kcal_low = entry.kcal_low ?? null;
  entry.kcal_high = entry.kcal_high ?? null;
}

type ExpenseRow = Record<string, unknown>;
const expenses: ExpenseRow[] = [
  { id: "e1", amount_cents: 2500, kind: "expense", note: "午餐", category: "餐饮", spent_at: at("12:35"), day: DAY, source: "chat", deleted_at: null, user_id: userRow.id, created_at: at("12:35") },
  { id: "e2", amount_cents: 800, kind: "expense", note: "地铁", category: "交通", spent_at: at("09:10"), day: DAY, source: "chat", deleted_at: null, user_id: userRow.id, created_at: at("09:10") },
  { id: "e3", amount_cents: 800000, kind: "income", note: "十月工资", category: "工资", spent_at: at("09:00"), day: DAY, source: "form", deleted_at: null, user_id: userRow.id, created_at: at("09:00") },
];

const routines: Array<Record<string, unknown>> = [
  { id: "r1", title: "晨间护肤", steps: [{ title: "温水洗脸", minutes: 3, stage: "" }, { title: "拍爽肤水", minutes: 2, stage: "" }, { title: "涂防晒", minutes: 2, stage: "" }], sort_order: 1, user_id: userRow.id, archived_at: null, created_at: at("08:02") },
  { id: "r2", title: "睡前整理桌面", steps: [{ title: "清空杯子", minutes: 2, stage: "" }, { title: "归位文具", minutes: 5, stage: "" }, { title: "擦一遍桌面", minutes: 5, stage: "" }], sort_order: 2, user_id: userRow.id, archived_at: null, created_at: at("08:02") },
];
const checkedKeys = new Set([`r1|${DAY}`]);

const messages: Array<Record<string, unknown>> = [
  { id: "m1", role: "assistant", content: env.wellnessEnabled ? "早呀。昨晚睡得不错，7 小时 58 分。今天想先从哪件小事开始？" : "我在的。今天想先从哪件小事开始？", day: DAY, created_at: at("08:03"), meta: { source: "demo" } },
  { id: "m2", role: "user", content: env.wellnessEnabled ? "我醒了" : "早上好", day: DAY, created_at: at("08:02"), meta: { source: "demo" } },
];
let reportRow: { stats: unknown; narrative: string | null; diary: string | null } | null = null;
const voiceReceipts = new Map<string, Record<string, unknown>>();
let currentFocus: Record<string, unknown> | null = null;

/** Build a row from `INSERT INTO t (a,b,c) VALUES (...)` + positional params. */
function rowFromInsert(sql: string, params: SqlParam[]): Record<string, unknown> {
  const match = sql.match(/INSERT INTO (\w+)\s*\(([^)]+)\)/i);
  const row: Record<string, unknown> = {};
  if (match) {
    const columns = match[2].split(",").map((c) => c.trim());
    columns.forEach((column, index) => {
      row[column] = params[index] === undefined ? null : params[index];
    });
  }
  return row;
}

function dayOfParam(params: SqlParam[], index: number): string | null {
  const value = params[index];
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function expenseTotalCents(day: string, kind?: string) {
  return expenses
    .filter((row) => row.day === day && !row.deleted_at && (!kind || row.kind === kind))
    .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
}

async function demoSql(sql: string, params: SqlParam[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const one = (row: Record<string, unknown> | null) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
  const many = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });

  if (/^SELECT 1/.test(sql)) return many([]);
  if (/SELECT .*FROM voice_requests/.test(sql)) return one(voiceReceipts.get(String(params[1])) || null);
  if (/INSERT INTO voice_requests/.test(sql)) {
    const key = String(params[1]);
    if (voiceReceipts.has(key)) return many([]);
    voiceReceipts.set(key, { input_hash: params[2], result: null });
    return one({ request_id: key });
  }
  if (/UPDATE voice_requests/.test(sql)) {
    const receipt = voiceReceipts.get(String(params[2]));
    if (receipt) receipt.result = JSON.parse(String(params[0]));
    return many([]);
  }
  // --- auth ---
  if (/FROM users WHERE email = \$1/.test(sql)) return one(params[0] === DEMO_EMAIL ? userRow : null);
  if (/FROM users WHERE id = \$1/.test(sql)) return one({ ...userRow, password_hash: undefined });
  if (/FROM users\b/.test(sql)) return many([{ id: userRow.id }]);
  if (/FROM device_tokens|FROM email_verification_tokens|FROM password_reset_tokens/.test(sql)) return many([]);
  // --- profile ---
  if (/FROM user_profile/.test(sql)) return one(profileRow);
  if (/INSERT INTO user_profile|UPDATE user_profile/.test(sql)) return one(profileRow);
  // --- state (GET and SELECT ... FOR UPDATE share the same match) ---
  if (/FROM user_app_state WHERE user_id/.test(sql)) return one(stateRow ? { state: stateRow.state, updated_at: stateRow.updated_at } : null);
  if (/UPDATE user_app_state|INSERT INTO user_app_state/.test(sql)) {
    const rawState = params.map((p) => (typeof p === "string" ? p : "")).find((p) => {
      try { return JSON.parse(p)?.version === 1; } catch { return false; }
    });
    if (rawState) {
      stateRow = { state: JSON.parse(rawState) as Record<string, unknown>, updated_at: new Date().toISOString() };
    }
    return { rows: [], rowCount: 1 };
  }
  // --- wellness ---
  if (/INSERT INTO wellness_entries/.test(sql)) {
    const row = rowFromInsert(sql, params);
    row.user_id = userRow.id;
    row.day = row.day || DAY;
    row.kb_version = row.kb_version || 1;
    row.protein_g = row.protein_g ?? 0;
    row.carb_g = row.carb_g ?? 0;
    row.fat_g = row.fat_g ?? 0;
    row.water_ml = row.water_ml ?? 0;
    row.sleep_min = row.sleep_min ?? 0;
    row.exercise_min = row.exercise_min ?? 0;
    row.occurred_at = row.occurred_at || new Date().toISOString();
    entries.push(row);
    return many([row]);
  }
  if (/FROM wellness_entries/.test(sql)) {
    const day = dayOfParam(params, 1);
    return many(entries.filter((row) => !day || row.day === day));
  }
  if (/FROM wellness_day_settings/.test(sql)) return many([]);
  // --- expenses ---
  if (/INSERT INTO expenses/.test(sql)) {
    const row = rowFromInsert(sql, params);
    row.user_id = userRow.id;
    row.kind = row.kind || "expense";
    row.deleted_at = null;
    row.created_at = new Date().toISOString();
    expenses.push(row);
    return many([row]);
  }
  // Aggregate must be matched BEFORE the generic `FROM expenses` branch.
  if (/SUM\(amount_cents/.test(sql)) {
    // The report counts spending only; income rows must not inflate it.
    const expenseOnly = /kind = 'expense'/.test(sql);
    return one({ cents: expenseTotalCents(dayOfParam(params, 1) || DAY, expenseOnly ? "expense" : undefined) });
  }
  if (/FROM expenses/.test(sql)) {
    const day = dayOfParam(params, 1);
    return many(expenses.filter((row) => !row.deleted_at && (!day || row.day === day)));
  }
  // --- routines ---
  if (/SELECT MAX\(c.day\)::text AS day FROM routine_checks/.test(sql)) {
    const before = String(params[1] || DAY);
    const days = [...checkedKeys].map(key => key.split("|")[1]).filter(day => day < before).sort();
    return one({ day: days.at(-1) || null });
  }

  if (/SELECT r.id, r.title, r.scenario, c.day::text AS day FROM routine_checks/.test(sql)) {
    const from=String(params[1]||DAY), to=String(params[2]||DAY);
    return many(routines.flatMap(row=>[...checkedKeys].filter(key=>key.startsWith(`${row.id}|`)).map(key=>({id:row.id,title:row.title,scenario:row.scenario||"life",day:key.split("|")[1]})).filter(row=>row.day>=from&&row.day<=to)));
  }
  if (/INSERT INTO routines/.test(sql)) {
    const row = rowFromInsert(sql, params);
    row.user_id = userRow.id;
    row.archived_at = null;
    row.created_at = new Date().toISOString();
    if (typeof row.steps === "string") {
      try { row.steps = JSON.parse(row.steps); } catch { row.steps = []; }
    }
    routines.push(row);
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE routines SET title = \$3/.test(sql)) {
    const row = routines.find((item) => item.id === params[0] && !item.archived_at);
    if (!row) return { rows: [], rowCount: 0 };
    row.title = params[2];
    try { row.steps = JSON.parse(String(params[3])); } catch { row.steps = []; }
    row.scenario = params[4];
    return { rows: [], rowCount: 1 };
  }
  if (/FROM routines r WHERE/.test(sql)) {
    const day = dayOfParam(params, 1) || DAY;
    return many(routines
      .filter((row) => !row.archived_at)
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
      .map((row) => ({
        id: row.id, title: row.title, scenario: row.scenario || "life", sort_order: row.sort_order,
        steps: Array.isArray(row.steps) ? row.steps : [],
        checked: checkedKeys.has(`${row.id}|${day}`),
      })));
  }
  if (/FROM routines WHERE id = \$1 AND user_id = \$2/.test(sql)) return one(routines.find((row) => row.id === params[0]) || null);
  if (/FROM routines WHERE user_id = \$1 AND title ILIKE/.test(sql)) {
    const keyword = String(params[1] || "").replace(/%/g, "");
    return one(routines.find((row) => !row.archived_at && String(row.title).includes(keyword)) || null);
  }
  if (/MAX\(sort_order\)/.test(sql)) return one({ max_order: routines.length });
  if (/SELECT r.title FROM routine_checks/.test(sql)) {
    const day = dayOfParam(params, 1) || DAY;
    return many(routines.filter(row => checkedKeys.has(`${row.id}|${day}`)).map(row => ({ title: row.title })));
  }
  if (/FROM routines/.test(sql)) return many(routines.filter((row) => !row.archived_at));
  if (/INSERT INTO routine_checks/.test(sql)) {
    checkedKeys.add(`${params[0]}|${params[1]}`);
    return { rows: [], rowCount: 1 };
  }
  if (/DELETE FROM routine_checks/.test(sql)) {
    checkedKeys.delete(`${params[0]}|${params[1]}`);
    return { rows: [], rowCount: 1 };
  }
  if (/COUNT\(\*\) AS count FROM routine_checks/.test(sql)) {
    const day = dayOfParam(params, 1) || DAY;
    return one({ count: [...checkedKeys].filter((key) => key.endsWith(`|${day}`)).length });
  }
  // --- chat ---
  if (/INSERT INTO chat_messages/.test(sql)) {
    const row = rowFromInsert(sql, params);
    row.user_id = userRow.id;
    row.created_at = row.created_at || new Date().toISOString();
    row.day = row.day || DAY;
    messages.push(row);
    return many([row]);
  }
  if (/FROM chat_messages/.test(sql)) return many([...messages].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
  // --- reports ---
  if (/INSERT INTO daily_reports/.test(sql)) {
    if (reportRow && /DO NOTHING/.test(sql)) return many([]);
    reportRow = { stats: params[2], narrative: String(params[3] || ""), diary: reportRow?.diary || null };
    return many([{ diary: reportRow.diary }]);
  }
  if (/SELECT diary FROM daily_reports/.test(sql)) return one(reportRow ? { diary: reportRow.diary } : null);
  if (/SELECT stats, narrative, diary FROM daily_reports/.test(sql)) return one(reportRow);
  if (/SELECT stats, narrative FROM daily_reports/.test(sql)) return one(reportRow ? { stats: reportRow.stats, narrative: reportRow.narrative } : null);
  if (/UPDATE daily_reports/.test(sql)) {
    if (reportRow) reportRow.diary = String(params[2] ?? "");
    return { rows: [], rowCount: 1 };
  }
  if (/FROM daily_reports/.test(sql)) return many([]);
  // --- focus ---
  if (/INSERT INTO focus_sessions/.test(sql)) {
    currentFocus = rowFromInsert(sql, params);
    currentFocus.user_id = userRow.id;
    currentFocus.status = "running";
    currentFocus.ended_at = null;
    currentFocus.elapsed_sec = 0;
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE focus_sessions/.test(sql)) {
    if (currentFocus) {
      for (let index = 0; index < params.length; index += 1) {
        const value = params[index];
        if (value === "running" || value === "paused" || value === "done" || value === "abandoned") currentFocus.status = value;
      }
    }
    return { rows: [], rowCount: 1 };
  }
  if (/FROM focus_sessions/.test(sql)) return one(currentFocus);
  if (/SUM\(elapsed_sec/.test(sql)) return one({ seconds: 0 });
  // --- usage & cache ---
  if (/FROM usage_calls/.test(sql)) return one({ li: 0, tokens: 0, calls: 0 });
  if (/INSERT INTO usage_calls|INSERT INTO parse_cache/.test(sql)) return { rows: [], rowCount: 1 };
  if (/FROM parse_cache|FROM personal_foods|FROM profile_facts|FROM life_events|FROM memory_nodes|FROM schema_migrations/.test(sql)) return many([]);
  // --- generic writes ---
  if (/^INSERT INTO|^UPDATE |^DELETE FROM/.test(sql)) return { rows: [], rowCount: 1 };
  return many([]);
}

const jwt = (await import("jsonwebtoken")).default;

const db = createFakeDb(demoSql);
const app = createApp(db, (scoped) => {
  /** Open /demo to land straight in the feature UI with a demo session cookie.
      Registered base-relative: createApp mounts this router under BASE_PATH. */
  scoped.get("/demo", (_req, res) => {
    const token = jwt.sign(
      { sub: userRow.id, email: userRow.email, tv: 0 },
      env.jwtSecret,
      { expiresIn: "7d" },
    );
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${env.basePath || "/"}; HttpOnly; SameSite=Lax; Max-Age=604800`,
    );
    res.redirect(env.baseUrlPath);
  });
});

const server = app.listen(Number(process.env.PORT), process.env.HOST, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : Number(process.env.PORT);
  console.log(`[demo] UpLoop with seeded data: http://127.0.0.1:${port}${env.baseUrlPath}`);
  console.log(`[demo] one-click UI (auto login): http://127.0.0.1:${port}${env.baseUrlPath}demo`);
  console.log(`[demo] login: ${DEMO_EMAIL} / 12345678  (day: ${DAY})`);
  console.log("[demo] data resets when this process exits; no DeepSeek key => rule-based replies");
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
