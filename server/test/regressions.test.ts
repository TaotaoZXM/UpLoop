import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { createFakeDb, type SqlParam } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { detectIntents, parseExpense } from "../src/chat/intent.js";
import { handleChat } from "../src/chat/router.js";

const web = fileURLToPath(new URL("../../web/", import.meta.url));

describe("PRD v1.2 migration and ledger regressions", () => {
  it("numeric and full-name migration caps include compatibility SQL but not optional memory", async () => {
    for (const cap of ["001", "001_init", "002", "002_memory"]) {
      const versions: string[] = [];
      const db = createFakeDb((sql, params) => {
        if (sql.startsWith("INSERT INTO schema_migrations")) versions.push(String(params[0]));
        return { rows: [], rowCount: 0 };
      });
      await migrate(db, cap);
      assert.deepEqual(versions, cap.startsWith("001")
        ? ["001_init", "001_task_scenario", "001_upgrade_ledger_routine", "001_upgrade_task_flowers", "001_voice_requests"]
        : ["001_init", "001_task_scenario", "001_upgrade_ledger_routine", "001_upgrade_task_flowers", "001_voice_requests", "002_memory"]);
    }
  });

  it("an already initialized database applies the compatibility migration once", async () => {
    const applied = new Set(["001_init"]);
    const sqls: string[] = [];
    const db = createFakeDb((sql, params) => {
      if (sql.startsWith("SELECT version")) return { rows: [...applied].map(version => ({ version })), rowCount: applied.size };
      if (sql.startsWith("INSERT INTO schema_migrations")) applied.add(String(params[0]));
      sqls.push(sql);
      return { rows: [], rowCount: 0 };
    });
    assert.equal(await migrate(db, "001"), 4);
    assert.equal(await migrate(db, "001"), 0);
    const upgrade = sqls.find(sql => sql.includes("ALTER TABLE expenses")) || "";
    assert.match(upgrade, /ADD COLUMN IF NOT EXISTS kind/);
    assert.match(upgrade, /ADD COLUMN IF NOT EXISTS steps/);
    await assert.rejects(migrate(db, "wrong-version"), /Invalid migration version/);
  });

  it("parses income, short expenses and mixed clauses without treating quantities as money", () => {
    for (const [text, kind, amount, category] of [
      ["今天工资到账 8000", "income", 8000, "工资"],
      ["报销到账 120.5", "income", 120.5, "报销"],
      ["午饭 32", "expense", 32, "餐饮"],
      ["花了 12.5 块 买咖啡", "expense", 12.5, "餐饮"],
      ["午饭 32 元", "expense", 32, "餐饮"],
      ["今天攀岩1小时，工资到账8000", "income", 8000, "工资"],
      ["买了100元理财", "expense", 100, null],
    ] as const) {
      const draft = parseExpense(text);
      assert.ok(detectIntents(text).includes("expense"), text);
      assert.deepEqual([draft?.kind, draft?.amount, draft?.category], [kind, amount, category], text);
    }
    assert.equal(parseExpense("花了 12.5 块 买咖啡")?.note, "买咖啡");
    assert.equal(parseExpense("午饭 32 元")?.note, "午饭");
    for (const text of ["喝水500毫升", "攀岩60分钟", "吃了150克鸡胸", "工资是多少", "收到5个苹果", "工资8000够吗", "今天天气不错"]) {
      assert.equal(parseExpense(text), null, text);
    }
  });

  it("chat persists income kind, category and requested day through the real handler", async () => {
    let written: SqlParam[] = [];
    const db = createFakeDb((sql, params) => {
      if (/FROM user_profile/.test(sql)) return { rows: [{ onboarded_at: "2026-11-01", cloud_consent: true }], rowCount: 1 };
      if (/FROM usage_calls/.test(sql)) return { rows: [{ li: 0, tokens: 0, calls: 0 }], rowCount: 1 };
      if (/INSERT INTO expenses/.test(sql)) {
        written = params;
        return { rows: [{ id: params[0], amount_cents: params[2], kind: params[3], note: params[4], category: params[5], day: params[7] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const response = await handleChat({ db }, { userId: "test-user", text: "今天工资到账 8000", day: "2026-11-04" });
    assert.equal(written[2], 800000);
    assert.equal(written[3], "income");
    assert.equal(written[5], "工资");
    assert.equal(written[7], "2026-11-04");
    assert.match(response.reply, /收入 8000.00 元/);
    assert.equal(response.cards.length, 1);
  });
});

// Minimal DOM event fixture: executes shipped scripts and handlers, with API
// requests captured at the boundary rather than asserting implementation text.
class Element {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  handlers: Record<string, (event?: unknown) => unknown> = {};
  children: Element[] = [];
  value = "";
  textContent = "";
  disabled = false;
  html = "";
  set id(value: string) { this.nodes[value] = this; }
  constructor(readonly nodes: Record<string, Element>) {}
  set innerHTML(value: string) {
    this.html = value;
    for (const match of value.matchAll(/id="([^"]+)"/g)) this.nodes[match[1]] = new Element(this.nodes);
  }
  get innerHTML() { return this.html; }
  replaceChildren() { this.children = []; }
  focus() {}
  appendChild(el: Element) { this.children.push(el); }
  insertBefore(el: Element) { this.children.unshift(el); }
  setAttribute() {}
  addEventListener(name: string, handler: (event?: unknown) => unknown) { this.handlers[name] = handler; }
  querySelectorAll(): Element[] { return []; }
  querySelector(): Element | null { return null; }
}

function fixture(api: (path: string, options?: { body?: string }) => Promise<unknown>) {
  const nodes: Record<string, Element> = {};
  const B: Record<string, any> = { api, dayKey: () => "2026-11-05" };
  const context = vm.createContext({
    crypto: { randomUUID }, localStorage: { getItem: () => "1" }, Task: B, Date, JSON, Number, String, Object, Array, Boolean, Math, console,
    btUrl: (path: string) => path,
    fetch: async (path: string) => ({ ok: true, json: () => api(path) }),
    document: { readyState: "loading", addEventListener() {},
      getElementById: (id: string) => nodes[id] || null,
      createElement: () => new Element(nodes), querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext("window = globalThis", context);
  return { B, nodes, context, element: () => new Element(nodes),
    load: (file: string) => vm.runInContext(readFileSync(web + file, "utf8"), context) };
}

describe("PRD v1.2 frontend regressions", () => {
  it("AI avatar distinguishes tap, long-press, release and pointer cancellation", () => {
    const f = fixture(async () => ({}));
    const timers = new Map<number, () => void>();
    let timer = 0;
    Object.assign(f.context, { setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; },
      clearTimeout: (id: number) => timers.delete(id), addEventListener() {} });
    f.load("js/voice.js");
    const trigger = f.element();
    const calls: string[] = [];
    f.B.voice.bindTrigger(trigger, { begin: () => calls.push("begin"), end: () => calls.push("end"), cancel: () => calls.push("cancel") });
    const down = { button: 0, pointerId: 1, clientX: 20, clientY: 20 };
    trigger.handlers.pointerdown(down); trigger.handlers.pointerup({ pointerId: 1 });
    assert.deepEqual(calls, []); assert.equal(timers.size, 0);
    trigger.handlers.pointerdown(down);
    [...timers.values()][0]();
    trigger.handlers.pointerup({ pointerId: 1 });
    assert.deepEqual(calls, ["begin", "end"]);
    let suppressed = false;
    trigger.handlers.click({ preventDefault() {}, stopImmediatePropagation() { suppressed = true; } });
    assert.equal(suppressed, true);
    trigger.handlers.pointerdown(down); [...timers.values()][0](); trigger.handlers.pointercancel();
    assert.deepEqual(calls, ["begin", "end", "begin", "cancel"]);
    trigger.handlers.pointerdown(down); trigger.handlers.pointermove({ pointerId: 1, clientX: 100, clientY: 100 });
    assert.equal(timers.size, 0); assert.equal(calls.length, 4);
  });
  it("typed and voice input share chat delivery and history reload does not duplicate bubbles", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const original = "我飲咗三百毫升水";
    const history = [{ role: "user", content: original, meta: { source: "voice" } }, { role: "assistant", content: "已记录", meta: {} }];
    const f = fixture(async (path, options) => {
      if (path === "/api/messages") return { messages: history };
      if (path === "/api/chat") { sent.push(JSON.parse(options!.body!)); return { reply: "已记录", cards: [], intent: "water" }; }
      return {};
    });
    f.nodes.startScreen = f.element();
    f.load("js/chat.js"); f.B.chat.init();
    await new Promise(resolve => setImmediate(resolve));
    const bubbleCount = () => f.nodes.taskChatList.children.length;
    assert.equal(bubbleCount(), 2);
    await f.B.chat.loadHistory(); assert.equal(bubbleCount(), 2);
    const sending = f.B.chat.sendText(original, "voice");
    assert.equal(f.nodes.taskChatList.children.at(-1)!.textContent, original);
    await sending;
    f.nodes.taskChatInput.value = "午饭32";
    await f.B.chat.send();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].source, "voice"); assert.equal(sent[1].source, "web");
    assert.equal(sent[0].text, original); assert.equal(sent[1].text, "午饭32");
    assert.ok(sent.every(payload => payload.requestId));
    await f.B.chat.loadHistory(); assert.equal(bubbleCount(), 2);
  });
  it("diary failure keeps the draft, reports failure and allows a successful retry", async () => {
    let fail = true;
    const requests: string[] = [];
    const f = fixture(async (_path, options) => {
      if (options?.body) {
        requests.push(options.body);
        if (fail) throw new Error("offline");
        return {};
      }
      return { diary: "server diary", narrative: "report" };
    });
    f.nodes.taskReportBody = f.element();
    Object.assign(f.context, { renderCal() {}, readAppState: () => ({ feedback: [] }) });
    f.load("js/records.js");
    await f.B.records.renderReport();
    const diary = f.nodes.taskDiary;
    diary.value = "my unsaved diary";
    diary.handlers.input();
    const button = f.nodes.taskDiarySave;
    await button.handlers.click();
    assert.equal(button.disabled, false);
    assert.equal(diary.value, "my unsaved diary");
    assert.match(f.nodes.taskReportBody.children.at(-1)!.textContent, /保存失败/);
    fail = false;
    await button.handlers.click();
    assert.match(f.nodes.taskReportBody.children.at(-1)!.textContent, /已保存/);
    assert.deepEqual(JSON.parse(requests[1]), { day: "2026-11-05", diary: "my unsaved diary" });
    await f.B.records.renderReport();
    assert.match(f.nodes.taskReportBody.innerHTML, /my unsaved diary/);
  });

  it("category requests use the selected ledger date and summarize income separately", async () => {
    const requests: string[] = [];
    const f = fixture(async path => {
      requests.push(path);
      return { items: [{ kind: "expense", category: "餐饮", amount: "32" }, { kind: "income", category: "工资", amount: "100" }] };
    });
    f.B.records = { expenseDay: () => "2026-10-20" };
    f.nodes.ledgerScreen = f.element();
    f.nodes.taskLedger = f.element();
    f.load("js/expense-subpages.js");
    // Initialization is intentionally deferred in this fixture.
    vm.runInContext("document.readyState = 'complete'", f.context);
    f.load("js/expense-subpages.js");
    const total = f.element();
    f.nodes.taskCategories.querySelector = () => total;
    f.B.expenseSubs.activate("categories");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests[0], "/api/expenses?day=2026-10-20");
    assert.match(total.innerHTML, /68.00/);
    assert.match(total.innerHTML, /收入 100.00 · 支出 32.00/);
  });

  it("dock opens Overview, delegates Manage, and resets Today", () => {
    const f = fixture(async () => ({}));
    f.B.features = { wellness: true };
    const phone = f.element();
    const legacy = f.element();
    const ai = f.element();
    const items = ["home", "manage", "today"].map(key => {
      const item = f.element(); item.dataset.dock = key; return item;
    });
    const calls: string[] = [];
    f.B.workspace = { navigate: (key: string) => calls.push(key) };
    f.B.wellness = { enter: () => calls.push("exercise") };
    f.B.expenseSubs = { activate: (key: string) => calls.push(key) };
    f.B.taskHub = { enter: (key: string) => calls.push(key), leave() {} };
    Object.assign(f.context, { calViewDate: new Date("2020-01-01"), calSelectedDate: new Date("2020-01-01"),
      showScreen: (key: string) => calls.push(key), MutationObserver: class { observe() {} } });
    const doc = f.context.document as any;
    doc.querySelector = (selector: string) => selector === ".phone" ? phone : selector === ".bottom-nav" ? legacy : null;
    doc.createElement = () => {
      const dock = f.element();
      dock.querySelector = () => ai;
      dock.querySelectorAll = () => items;
      return dock;
    };
    doc.readyState = "complete";
    f.load("js/dock.js");
    for (const item of items) item.handlers.click();
    assert.deepEqual(calls, ["start", "manage", "today"]);
    assert.equal((f.context.calViewDate as Date).getFullYear(), new Date().getFullYear());
    assert.equal((f.context.calSelectedDate as Date).toDateString(), new Date().toDateString());
  });
});
