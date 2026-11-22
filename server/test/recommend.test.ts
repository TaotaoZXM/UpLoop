import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const webIndex = readFileSync(join(root, "web", "index.html"), "utf8");

describe("energy selection and difficulty-priority recommendations are gone", () => {
  it("the start screen no longer offers energy buttons or a 3-task picker", () => {
    assert.equal(webIndex.includes(">低能量<"), false);
    assert.equal(webIndex.includes(">中能量<"), false);
    assert.equal(webIndex.includes(">高能量<"), false);
    assert.equal(webIndex.includes('id="stateBlock"'), false);
    assert.equal(webIndex.includes('id="recommendations"'), false);
    assert.equal(webIndex.includes("const recommendationRules={"), false);
    assert.equal(webIndex.includes("function chooseRecommendationIdsFrom("), false);
    assert.equal(webIndex.includes("function selectEnergy("), false);
    assert.equal(webIndex.includes("按此刻的状态为你挑选 3 件事"), false);
  });
  it("chat lightstart no longer ranks three tasks by energy or difficulty", () => {
    const router = readFileSync(join(root, "server", "src", "chat", "router.ts"), "utf8");
    assert.equal(router.includes("recommendTasks"), false);
    assert.equal(router.includes("energyFrom"), false);
    assert.match(router, /Overview 抽一张任务卡/);
  });
});

describe("D1.6: index.html existing slice-tested functions are untouched", () => {
  const names = (html: string) => [...html.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);

  it("does not restore retired energy recommendation helpers", () => {
    const removed = new Set([
      "updateDifficultyChoices",
      "recommendationStorageKey",
      "loadDailyRecommendations",
      "saveDailyRecommendations",
      "rollRecommendationDay",
      "chooseRecommendationIdsFrom",
      "chooseRecommendationIds",
      "fillSavedPushIds",
      "refreshRecommendationIds",
      "ensureRecommendationIds",
      "currentPushEnergy",
      "fillCurrentPushSlots",
      "pushColumnPlan",
      "recommendationBits",
      "appendRecommendationRow",
      "settledPushItems",
      "renderRecommendations",
      "selectEnergy",
    ]);
    const present = new Set(names(webIndex));
    for (const name of removed) {
      assert.equal(present.has(name), false, name);
    }
  });

  it("new modules load as deferred scripts, with no build step", () => {
    for (const file of ["onboarding.js", "chat.js", "wellness.js", "records.js", "task-hub.js", "dock.js"]) {
      assert.ok(webIndex.includes(`<script defer src="./js/${file}"></script>`));
      assert.ok(readFileSync(join(root, "web", "js", file), "utf8").length > 0);
    }
    assert.ok(webIndex.includes('./css/opengym.css'));
    assert.ok(webIndex.includes('./css/dock.css'));
    assert.ok(webIndex.includes('./css/task-hub.css'));
    assert.ok(webIndex.includes('./css/subpages.css'));
    assert.equal(/<script type="module"/.test(webIndex), false);
  });

  it("WP1.5: cache name bumped and new assets precached", () => {
    const sw = readFileSync(join(root, "web", "sw.js"), "utf8");
    assert.match(sw, /const CACHE = "task-v\d+"/);
    // The cache bucket must not carry the legacy app name.
    const cacheLine = sw.split("\n").find((line) => line.startsWith("const CACHE")) || "";
    assert.equal(/qingzhou/.test(cacheLine), false);
    for (const file of ["chat.js", "wellness.js", "onboarding.js", "records.js", "task-hub.js", "dock.js", "opengym.css", "dock.css", "task-hub.css", "subpages.css"]) {
      assert.ok(sw.includes(file));
    }
    // API bypass must follow the mount prefix, not assume the host root.
    assert.ok(sw.includes('startsWith(BASE + "api/")'));
    assert.ok(sw.includes('startsWith(BASE + "v1/")'));
    // Only task-* buckets are pruned; qingzhou shares the origin's CacheStorage.
    assert.ok(sw.includes("key.startsWith(PREFIX)"));
  });

  it("dock renders the three workspace destinations without a bottom AI orb", () => {
    const dock = readFileSync(join(root, "web", "js", "dock.js"), "utf8");
    assert.equal(dock.includes('id="taskDockAi"'), false);
    for (const [label, screen] of [
      ["Home", "start"], ["My Tasks", "manage"], ["Daily Recap", "today"],
    ] as const) {
      assert.ok(dock.includes(`label: "${label}", screen: "${screen}"`), `${label} -> ${screen}`);
    }
    assert.equal(dock.includes('label: "Expense"'), false);
    assert.ok(webIndex.includes('id="ideaScreen"'));
    assert.equal(webIndex.includes('<script defer src="./js/expense-subpages.js"></script>'), false);
    // The legacy bar must stay in the DOM: showScreen() still toggles its buttons.
    for (const id of ["chatNav", "recordsNav", "modulesNav", "meNav"]) {
      assert.ok(webIndex.includes(`id="${id}"`));
    }
  });

  it("M01: Task grid sits at the very top of the open sub-page; default is To-do; no 今天 card", () => {
    const taskHub = readFileSync(join(root, "web", "js", "task-hub.js"), "utf8");
    for (const label of ["To-do", "Done", "任务复盘", "正反馈"]) {
      assert.ok(taskHub.includes(`label: "${label}"`), label);
    }
    assert.equal(taskHub.includes('key: "ideas", label:'), false);
    assert.ok(taskHub.includes('data-hub="'));
    // No standalone hub screen and no "今天" summary card.
    assert.equal(taskHub.includes("taskHubScreen"), false);
    assert.equal(taskHub.includes("task-task-summary"), false);
    assert.equal(/今天<\/strong>/.test(taskHub), false);
    // The grid is the FIRST element of the sub-page screen — nothing renders
    // above it — and it is hidden when the Task hierarchy is left.
    assert.ok(taskHub.includes("screen.insertBefore(grid, screen.firstChild)"));
    assert.equal(taskHub.includes("afterend"), false);
    assert.ok(taskHub.includes('grid.style.display = "none"'));
    // Tapping Task opens the FIRST sub-page (To-do).
    assert.ok(taskHub.includes("open: function () { enter(SUBS[0].key); }"));
    // Dock still routes Task through the hub module.
    assert.ok(readFileSync(join(root, "web", "js", "dock.js"), "utf8").includes('B.workspace.navigate("manage")'));
  });

  it("UI: one unified light theme across all surfaces", () => {
    const opengym = readFileSync(join(root, "web", "css", "opengym.css"), "utf8");
    // The Wellness records page dropped the dark openGym palette.
    assert.equal(/#000\b|background:\s*#000/.test(opengym), false);
    assert.equal(/#c8ff3a|#1b1d1b|#141614/.test(opengym), false);
    assert.ok(opengym.includes("var(--accent)"));
    assert.ok(opengym.includes("var(--accent-soft)"));
    // Category summary labels use the token, not hardcoded gray.
    const expense = readFileSync(join(root, "web", "js", "expense-subpages.js"), "utf8");
    assert.equal(expense.includes("#7c857e"), false);
  });

  it("public snapshot deploy example uses local placeholders and default port 3200", () => {
    const deploy = join(root, "deploy");
    const env = readFileSync(join(deploy, ".env.example"), "utf8");
    assert.match(env, /PORT=3200/);
    assert.match(env, /BASE_PATH=\/task/);
    assert.match(env, /SERVE_STATIC=1/);
    assert.match(env, /DATABASE_URL=postgresql:\/\/uploop:replace-with-a-local-password@127\.0\.0\.1:5432\/uploop/);
    assert.match(env, /JWT_SECRET=replace-with-a-long-random-string/);
    assert.match(env, /DEVICE_TOKEN_SECRET=replace-with-a-long-random-string/);
    assert.equal(/KEEP THE SAME VALUE AS THE OLD DEPLOYMENT|PORT=3000/.test(env), false);
    const files = readdirSync(deploy);
    assert.equal(files.includes("qingzhou.service"), false);
    assert.equal(files.includes("nginx-qingzhou.conf"), false);
    assert.equal(files.includes("enable-https.sh"), false);
    const envTs = readFileSync(join(root, "server", "src", "env.ts"), "utf8");
    assert.match(envTs, /port: int\("PORT", 3200\)/);
  });

  it("M02: Wellness sub-pages are ordered 运动/饮食/睡眠/喝水 with no grouped heading", () => {
    const wellness = readFileSync(join(root, "web", "js", "wellness.js"), "utf8");
    const order = [...wellness.matchAll(/\{ key: "(exercise|food|sleep|water)", label: "([^"]+)" \}/g)]
      .map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(order, ["exercise:运动", "food:饮食", "sleep:睡眠", "water:喝水"]);
    assert.equal(/og-section-label">健康四卡/.test(wellness), false);
    assert.equal(/健康四卡/.test(wellness), false);
    assert.ok(wellness.includes('data-kind="'));
  });

  it("M02/M05: Today shows only the original Cal content, then the report", () => {
    // todayScreen = exactly the former qingzhou Cal section (no Done content).
    const todayStart = webIndex.indexOf('<section id="todayScreen"');
    const todayEnd = webIndex.indexOf("</section>", todayStart);
    const todaySection = webIndex.slice(todayStart, todayEnd);
    for (const marker of ['class="cal-header"', 'id="calMonthTitle"', 'id="calSelectedTitle"', 'id="calRecords"']) {
      assert.ok(todaySection.includes(marker), marker);
    }
    assert.equal(/done-tabs|doneList|CLOSED LOOP|newEvent/.test(todaySection), false);
    // doneScreen keeps the Done content for the Task hub's Done sub-page.
    const doneStart = webIndex.indexOf('<section id="doneScreen"');
    const doneEnd = webIndex.indexOf("</section>", doneStart);
    const doneSection = webIndex.slice(doneStart, doneEnd);
    assert.ok(doneSection.includes("doneList"));
    assert.equal(/cal-month|calRecords|LOOKING BACK/.test(doneSection), false);
    // calScreen (Wellness) stays empty apart from the injected host.
    const calStart = webIndex.indexOf('<section id="calScreen"');
    const calEnd = webIndex.indexOf("</section>", calStart);
    assert.equal(/cal-month|calRecords|LOOKING BACK/.test(webIndex.slice(calStart, calEnd)), false);
    // The report panel follows the Cal content inside todayScreen.
    const records = readFileSync(join(root, "web", "js", "records.js"), "utf8");
    assert.ok(records.includes('panel("todayScreen", "taskReport", "今日回顾")'));
    assert.ok(webIndex.includes("if(name==='cal'||name==='today')renderCal();"));
  });

  it("M04: one merged 收支记录 ledger for income + expense; form is 金额/分类可选/明细", () => {
    const expense = readFileSync(join(root, "web", "js", "expense-subpages.js"), "utf8");
    const order = [...expense.matchAll(/\{ key: "(ledger|income|expense|categories)", label: "([^"]+)" \}/g)]
      .map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(order, ["ledger:收支记录", "categories:收支分类"]);
    // No separate income panel and no localStorage fallback any more.
    assert.ok(expense.includes('getElementById("taskLedger")'));
    assert.equal(/taskIncome|task-income-v1|insertBefore\(incomeBox/.test(expense), false);
    assert.ok(expense.includes("收支 · 按日流水"));
    // The merged ledger form: kind toggle + 金额 + 分类可选 + 明细 (no 买了什么).
    const records = readFileSync(join(root, "web", "js", "records.js"), "utf8");
    const formStart = records.indexOf('id="taskExpenseKind"');
    const catAt = records.indexOf('id="taskExpenseNewCategory"');
    const noteAt = records.indexOf('placeholder="明细"');
    assert.ok(formStart > -1 && catAt > formStart && noteAt > catAt, "分类可选 sits left of 明细");
    assert.equal(records.includes("买了什么"), false);
    assert.ok(records.includes("kind: expenseKind"));
    assert.ok(records.includes('data-kind="income"'));
    // Backend: expenses.kind column, kind-aware categories, report excludes income.
    const migration = readFileSync(join(root, "server", "src", "db", "migrations", "001_init.sql"), "utf8");
    assert.match(migration, /kind text NOT NULL DEFAULT 'expense'/);
    const routes = readFileSync(join(root, "server", "src", "ledger", "routes.ts"), "utf8");
    assert.match(routes, /INCOME_CATEGORIES/);
    assert.match(routes, /normalizeKind/);
    assert.match(routes, /incomeYuan/);
    const report = readFileSync(join(root, "server", "src", "report", "routes.ts"), "utf8");
    assert.match(report, /AND kind = 'expense'/);
    const account = readFileSync(join(root, "server", "src", "account", "routes.ts"), "utf8");
    assert.match(account, /amount_cents, kind, note/);
  });

  it("M05: routines carry ordered steps, shown line by line once checked", () => {
    const records = readFileSync(join(root, "web", "js", "records.js"), "utf8");
    assert.equal(records.includes("function routineStepRow(n)"), false);
    assert.ok(records.includes('data-checklist-open'));
    assert.equal(records.includes('class="task-step-no"'), false);
    assert.ok(readFileSync(join(root, "web", "index.html"), "utf8").includes('checklists:mergeRecords'));
    const migration = readFileSync(join(root, "server", "src", "db", "migrations", "001_init.sql"), "utf8");
    assert.match(migration, /steps jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    const routes = readFileSync(join(root, "server", "src", "routine", "routes.ts"), "utf8");
    assert.match(routes, /\$4::jsonb/);
    assert.match(routes, /MAX_STEPS = 60/);
    assert.match(routes, /UPDATE routines SET title = \$3/);
    assert.match(routes, /steps: stepsOf\(row\.steps\)/);
  });

  it("F-S3: the chat home drops the entry tiles, greeting stays static", () => {
    // User request: remove 今天请开始吧 / 今天的正反馈 / 给今天留出一个可以进入的入口.
    assert.equal(/今天请开始吧|今天的正反馈|给今天留出一个可以进入的入口/.test(webIndex), false);
    assert.ok(webIndex.includes("现在状态如何，<br><span>要不要先开始？</span>"));
    // Greeting is static copy, not a light-start / energy-panel trigger.
    assert.equal(webIndex.includes("getElementById('startGreeting').onclick"), false);
    // Legacy lookups in applyStartPanel must be optional (no null deref).
    assert.ok(webIndex.includes("if(beginTile){"));
    assert.ok(webIndex.includes("if(startSub)startSub.classList"));
  });

  it("F-S5: no quota/usage amounts on any application surface", () => {
    const surfaces = [webIndex, ...["onboarding.js", "chat.js", "wellness.js", "records.js", "task-hub.js", "dock.js"]
      .map((f) => readFileSync(join(root, "web", "js", f), "utf8"))];
    for (const surface of surfaces) {
      // PRD forbids RMB symbols and quota/usage NUMBERS; a sentence stating
      // "用量或费用不显示" is not a number and is allowed (qingzhou's original copy).
      assert.equal(/¥|￥|额度[：:]?\s*\d|用量[：:]?\s*\d|本月\s*\d+\s*元/.test(surface), false);
    }
  });

  it("VOICE uses the AI avatar hold gesture and shared chat delivery", () => {
    assert.ok(webIndex.includes('<script defer src="./js/voice.js"></script>'));
    const voice = readFileSync(join(root, "web", "js", "voice.js"), "utf8");
    assert.match(voice, /B\.chat\.sendText/);
    assert.match(voice, /pointerdown/);
    assert.match(voice, /MediaRecorder/);
  });
});

/** Load a new front-end file in node:vm so its pure helpers can be unit-tested. */
function loadFrontend(file: string): Record<string, never> {
  const code = readFileSync(join(root, "web", "js", file), "utf8");
  const context: Record<string, unknown> = {
    console,
    Math, Date, Number, String, Object, Array, JSON, Set, Map, Boolean, RegExp, Error,
    EventTarget, CustomEvent, URL, Blob,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    location: { reload: () => undefined },
    document: {
      readyState: "complete",
      getElementById: () => null,
      createElement: () => ({
        style: {}, classList: { add() {} }, setAttribute() {}, addEventListener() {},
        appendChild() {}, querySelector: () => null, querySelectorAll: () => [], remove() {}, innerHTML: "",
      }),
      addEventListener: () => undefined,
      body: { appendChild: () => undefined },
    },
  };
  context.window = context;
  vm.runInNewContext(code, context);
  return (context.Task || {}) as Record<string, never>;
}

describe("new front-end modules expose testable pure helpers", () => {
  it("wellness day switching", () => {
    const B = loadFrontend("wellness.js") as unknown as { wellness: { shiftDay: (d: string, n: number) => string } };
    assert.equal(B.wellness.shiftDay("2026-11-04", 1), "2026-11-05");
    assert.equal(B.wellness.shiftDay("2026-12-31", 1), "2027-01-01");
  });

  it("chat card rendering never shows a quota amount", () => {
    const B = loadFrontend("chat.js") as unknown as { chat: { cardText: (c: unknown) => string } };
    assert.match(B.chat.cardText({ type: "food", kcal: 210, estimated: true }), /估算/);
    assert.match(B.chat.cardText({ type: "water", water_ml: 300 }), /300 ml/);
  });

  it("records day switching", () => {
    const B = loadFrontend("records.js") as unknown as { records: { shift: (d: string, n: number) => string } };
    assert.equal(B.records.shift("2026-11-04", -1), "2026-11-03");
  });

  it("onboarding exposes the four-step draft with no goals field", () => {
    const B = loadFrontend("onboarding.js") as unknown as { onboarding: { draft: Record<string, unknown> } };
    assert.ok("gender" in B.onboarding.draft);
    assert.ok("birthYm" in B.onboarding.draft);
    assert.ok("cloudConsent" in B.onboarding.draft);
    assert.equal("goals" in B.onboarding.draft, false);
  });
});
