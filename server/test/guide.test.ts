import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";

type Parsed = { title: string; date: string; time: string; scenario: string };
type Guide = {
  read: (text: string, now: Date) => Parsed;
  latestStart: (plan: unknown, deadline: string) => string;
  dateOptions: (now: Date, kind?: string) => { key: string; label: string }[];
  timeOptions: (key: string, now: Date, kind?: string) => { key: string; label: string }[];
  whenText: (key: string, time: string, now: Date) => string;
  totalText: (minutes: number) => string;
  SCENES: Record<string, string>;
};

function load(): Guide {
  const context = vm.createContext({ Date, Number, String, Array, Object, JSON, Math, RegExp, Error });
  vm.runInContext("window = globalThis", context);
  vm.runInContext(readFileSync(new URL("../../web/js/guide.js", import.meta.url), "utf8"), context);
  return (context as unknown as { Task: { guide: Guide } }).Task.guide;
}

// Tuesday 2026-11-17, 10:00
const NOW = new Date(2026, 10, 17, 10, 0);
const step = (minutes: number, waitDays = 0, done = false) => ({ id: "s" + minutes, title: "查官网材料清单", minutes, waitDays, done });

describe("Overview guide reads one sentence", () => {
  const guide = load();
  const read = (text: string) => ({ ...guide.read(text, NOW) });

  it("takes a deadline day and removes it from the title", () => {
    assert.deepEqual(read("下周五前把签证材料交了"), { title: "把签证材料交了", date: "2026-11-27", time: "", scenario: "life" });
    assert.deepEqual(read("我要在11月30号之前办完日本签证"), { title: "办完日本签证", date: "2026-11-30", time: "", scenario: "life" });
    assert.equal(read("后天去体检").date, "2026-11-19");
    assert.equal(read("三天后给妈妈寄快递").date, "2026-11-20");
    assert.equal(read("月底前整理报销发票").date, "2026-11-30");
    assert.equal(read("十二月二十号前交报告").date, "2026-12-20");
  });

  it("rolls past dates into next year and rejects impossible ones", () => {
    assert.equal(read("11月3日交材料").date, "2027-11-03");
    assert.equal(read("2027年1月3日订机票").date, "2027-01-03");
    assert.equal(read("2月30日交材料").date, "");
  });

  it("reads clock times with the right half of the day", () => {
    assert.deepEqual(read("明天下午三点半和客户开会"), { title: "和客户开会", date: "2026-11-18", time: "15:30", scenario: "work" });
    assert.equal(read("今晚8点跑步").time, "20:00");
    assert.equal(read("提醒我晚上九点吃药").time, "21:00");
    assert.equal(read("早上8:30吃早饭").time, "08:30");
  });

  it("puts a bare time on the next day when it has already passed", () => {
    assert.equal(read("9点开周会").date, "2026-11-18");
    assert.equal(read("下午三点开周会").date, "2026-11-17");
  });

  it("does not mistake other words for dates or times", () => {
    for (const text of ["周报", "每周一写周报", "坐3号线去公司", "要多睡一点", "准备下周的面试"]) {
      const parsed = read(text);
      assert.equal(parsed.date, "", text);
      assert.equal(parsed.time, "", text);
    }
    assert.equal(read("每周一写周报").title, "每周一写周报");
    assert.equal(read("要多睡一点").title, "多睡一点");
  });

  it("guesses the scene only when the words point one way", () => {
    assert.equal(read("给客户发报价").scenario, "work");
    assert.equal(read("去超市买菜").scenario, "life");
    assert.equal(read("周末去旅行放松一下").scenario, "life");
    assert.equal(read("整理一下").scenario, "");
    assert.equal(read("开会前去超市").scenario, "");
  });

  it("keeps the sentence as the title when nothing is left", () => {
    assert.equal(read("明天").title, "明天");
    assert.equal(read("   ").title, "");
  });
});

describe("Overview guide deadline helpers", () => {
  const guide = load();

  it("finds the last day to start from effort (4 h a day) and waiting days", () => {
    assert.equal(guide.latestStart({ stages: [{ steps: [step(10), step(30)] }] }, "2026-11-27"), "2026-11-27");
    assert.equal(guide.latestStart({ stages: [{ steps: [step(240), step(240), step(120)] }] }, "2026-11-27"), "2026-11-25");
    assert.equal(guide.latestStart({ stages: [{ steps: [step(10, 3)] }] }, "2026-11-27"), "2026-11-24");
    assert.equal(guide.latestStart({ stages: [{ steps: [step(600, 0, true), step(10)] }] }, "2026-11-27"), "2026-11-27");
    assert.equal(guide.latestStart({ stages: [{ steps: [step(10)] }] }, ""), "");
  });

  it("writes the plan total exactly, never as 半天", () => {
    assert.equal(guide.totalText(45), "45 分钟");
    assert.equal(guide.totalText(120), "2 小时");
    assert.equal(guide.totalText(330), "5 小时 30 分");
  });

  it("offers only 工作 and 生活", () => {
    assert.deepEqual(Object.keys(guide.SCENES), ["work", "life"]);
    assert.deepEqual(Object.values(guide.SCENES), ["工作", "生活"]);
  });

  it("offers each quick deadline once, nearest first", () => {
    const labels = (now: Date) => Array.from(guide.dateOptions(now), item => item.label);
    assert.deepEqual(labels(NOW), ["今天", "明天", "本周日", "下周日"]);
    assert.deepEqual(labels(new Date(2026, 10, 21)), ["今天", "明天", "下周日"]); // Saturday: Sunday is tomorrow
    assert.deepEqual(labels(new Date(2026, 10, 22)), ["今天", "明天", "下周日"]); // Sunday
    const keys = Array.from(guide.dateOptions(NOW), item => item.key);
    assert.deepEqual(keys, ["2026-11-17", "2026-11-18", "2026-11-22", "2026-11-29"]);
  });
});

describe("Voice input stays inline for the AI page", () => {
  const read = (file: string) => readFileSync(new URL("../../web/" + file, import.meta.url), "utf8");
  const html = read("index.html"), sw = read("sw.js"), voice = read("js/voice.js"), assistant = read("js/assistant.js");

  it("loads the new files and precaches them", () => {
    for (const file of ["js/guide.js", "js/assistant.js", "js/draw.js", "css/assistant.css", "css/draw.css"]) {
      assert.ok(sw.includes('"./' + file + '"'), file);
      assert.ok(html.includes(file), file);
    }
    assert.equal(html.includes("css/guide.css"), false);
  });

  it("uses the voice module inline, without the old dialog", () => {
    assert.match(assistant, /B\.voice\.beginHold\(\{ onText/);
    assert.match(voice, /if \(!sink\) dialog\.show\(\)/);
    assert.match(voice, /await target\.onText\(text\)/);
  });

  it("sends a dock long-press recording into the guided flow, not the chat", () => {
    assert.match(voice, /B\.assistant\?\.say/);
  });
});

describe("Overview guide time choices", () => {
  const guide = load();
  const at = (h: number, m = 0) => new Date(2026, 10, 17, h, m);

  it("drops deadline times that have already passed today", () => {
    const keys = (now: Date, day: string) => Array.from(guide.timeOptions(day, now), item => item.key);
    assert.deepEqual(keys(at(10), "2026-11-17"), ["12:00", "15:00", "18:00", "21:00", "23:59"]);
    assert.deepEqual(keys(at(19), "2026-11-17"), ["21:00", "23:59"]);
    assert.deepEqual(keys(at(10), "2026-11-18"), ["10:00", "12:00", "15:00", "18:00", "21:00", "23:59"]);
  });

  it("drops finished-event times that are still ahead today", () => {
    const keys = (now: Date, day: string) => Array.from(guide.timeOptions(day, now, "past"), item => item.key);
    assert.deepEqual(keys(at(13, 20), "2026-11-17"), ["13:20", "08:00", "12:00"]);
    assert.deepEqual(keys(at(13, 20), "2026-11-16"), ["08:00", "12:00", "15:00", "18:00", "21:00"]);
  });

  it("offers today, yesterday and the day before for finished events", () => {
    assert.deepEqual(Array.from(guide.dateOptions(at(10), "past"), item => item.key), ["2026-11-17", "2026-11-16", "2026-11-15"]);
  });

  it("names a date and time the way the note shows it", () => {
    assert.equal(guide.whenText("2026-11-18", "15:30", at(10)), "明天 周三 15:30");
    assert.equal(guide.whenText("2026-11-17", "", at(10)), "今天 周二");
    assert.equal(guide.whenText("2026-11-16", "", at(10)), "昨天 周一");
    assert.equal(guide.whenText("2026-12-05", "", at(10)), "12月5日 周六");
    assert.equal(guide.whenText("", "", at(10)), "");
  });
});

describe("Overview draw helpers", () => {
  const context = vm.createContext({ Date, Number, String, Array, Object, JSON, Math, RegExp, Error });
  vm.runInContext("window = globalThis; Task = { escape: s => String(s) }", context);
  vm.runInContext(readFileSync(new URL("../../web/js/draw.js", import.meta.url), "utf8"), context);
  const draw = (context as unknown as { Task: { draw: any } }).Task.draw;
  const NOW = new Date(2026, 10, 17, 10, 0);

  it("describes how soon a deadline is", () => {
    assert.deepEqual({ ...draw.dueInfo("2026-11-27T23:59", NOW) }, { days: 10, rel: "还有 10 天", tone: "calm", date: "11月27日 周五" });
    assert.equal(draw.dueInfo("2026-11-17T23:59", NOW).rel, "今天截止");
    assert.equal(draw.dueInfo("2026-11-18T15:30", NOW).date, "11月18日 周三 15:30");
    assert.equal(draw.dueInfo("2026-11-18T15:30", NOW).tone, "soon");
    assert.equal(draw.dueInfo("2026-11-15T09:00", NOW).rel, "已逾期 2 天");
    assert.equal(draw.dueInfo("2026-11-15T09:00", NOW).tone, "late");
    assert.equal(draw.dueInfo("", NOW), null);
  });

  it("reports plan progress and the next step", () => {
    const plan = { stages: [{ steps: [{ title: "查清单", done: true }, { title: "拍照", done: false }, { title: "递交", done: false }] }] };
    assert.deepEqual({ ...draw.progress(plan) }, { total: 3, done: 1, next: "拍照", ratio: 1 / 3 });
    assert.equal(draw.progress(null), null);
    assert.equal(draw.progress({ stages: [] }), null);
  });

  it("puts sooner deadlines first and keeps undated tasks in their own order", () => {
    const list = [{ id: "a", deadline: "" }, { id: "b", deadline: "2026-11-20T23:59" }, { id: "c", deadline: "" }, { id: "d", deadline: "2026-11-18T09:00" }];
    assert.deepEqual(Array.from(draw.order(list), (item: { id: string }) => item.id), ["d", "b", "a", "c"]);
  });
});

describe("AI page, Manage and timeline wiring", () => {
  const read = (file: string) => readFileSync(new URL("../../web/" + file, import.meta.url), "utf8");
  const html = read("index.html"), assistant = read("js/assistant.js"), workspace = read("js/workspace.js"), css = read("css/theme-v5.css"), draw = read("js/draw.js");

  it("loads guide.js before assistant.js and workspace.js before draw.js", () => {
    const at = (name: string) => html.indexOf('<script defer src="./js/' + name + '"></script>');
    assert.ok(at("guide.js") < at("assistant.js"));
    assert.ok(at("workspace.js") < at("draw.js"));
  });

  it("opens the same conversation from the Manage + buttons", () => {
    assert.match(html, /Task\.assistant\.open\(\{mode:'task'/);
    assert.match(html, /Task\.assistant\.open\(\{mode:'done'/);
    assert.match(html, /document\.getElementById\('newEvent'\)\.onclick=openNewDone/);
    assert.match(assistant, /\/api\/tasks\/decompose/);
    assert.equal(/\/api\/chat/.test(assistant), false);
  });

  it("has no 休息 scene left in the UI, and Overview has no scene switcher", () => {
    assert.equal(/data-scenario="rest"/.test(html), false);
    assert.equal(/rest:'休息'/.test(html), false);
    assert.equal(/sceneNames|ws-scene|task-overview-scene/.test(workspace + css), false);
    assert.match(html, /item\.scenario==='rest'\)item\.scenario='life'/);
  });
  it("has no energy picker or difficulty-priority 3-task recommendations in the UI", () => {
    assert.equal(html.includes(">低能量<") || html.includes(">中能量<") || html.includes(">高能量<"), false);
    assert.equal(html.includes('id="stateBlock"') || html.includes("const recommendationRules={"), false);
    assert.equal(html.includes("function selectEnergy("), false);
  });

  it("再来一个 keeps the current conversation instead of rebuilding the chat", () => {
    assert.match(assistant, /again\(\) \{ restart\(\); \}/);
    assert.match(assistant, /function startMode\(mode, keepThread\)/);
    assert.match(assistant, /if \(keepThread && root\.dataset\.view === "chat" && thread\) refreshSlip\(\)/);
    assert.match(assistant, /else enterChat\(\)/);
    assert.match(assistant, /settle\("再来一个"\)/);
    assert.match(assistant, /startMode\(mode, true\)/);
    assert.match(assistant, /const keepThread = root\?\.dataset\.view === "chat" && thread/);
    assert.match(assistant, /if \(keepThread\) settle\(text\)/);
    assert.match(assistant, /if \(!keepThread\) enterChat\(\)/);
    assert.equal(/function begin\([\s\S]*?F = fresh\(mode, source\);\s*enterChat\(\);/.test(assistant), false);
    assert.equal(/function restart\(\) \{ const mode = F\.mode; F\.ticket\+\+; startMode\(mode\); \}/.test(assistant), false);
  });

  it("the new-task chat no longer offers 更多设置 or opens the edit sheet from it", () => {
    assert.equal(assistant.includes("更多设置"), false);
    assert.equal(assistant.includes("moreSettings"), false);
    assert.equal(/opt\("more"/.test(assistant), false);
    assert.equal(/B\.taskCards\?\.edit/.test(assistant), false);
    assert.match(assistant, /opt\("again", "", "再来一个"/);
    // Ordinary Manage / card edit access stays outside this conversation.
    const cards = read("js/task-card.js");
    assert.match(cards, /B\.taskCards=\{edit\}/);
    assert.match(cards, /openTaskForm\(/);
  });

  it("asks for scene, repeat, deadline, work project and steps in order", () => {
    const form = html.slice(html.indexOf('id="todoSheet"'), html.indexOf('id="reviewDialog"'));
    assert.doesNotMatch(form, /data-priority=|new(Task|Done)Review/);
    assert.doesNotMatch(assistant, /pick-priority|pick-review/);
    const flow = assistant.slice(assistant.indexOf("const missing ="), assistant.indexOf("const QUESTION"));
    const context = vm.createContext({});
    vm.runInContext("let F;" + flow, context);
    const draft = { mode: "task", scene: "", repeat: undefined as boolean | undefined, date: null as string | null, deadlineAsked:false, projectAsked: false };
    function next(patch: Partial<typeof draft> & { split?: boolean; repeatDays?: number }) {
      Object.assign(draft, patch);
      return vm.runInContext("F = " + JSON.stringify(draft) + "; missing()", context);
    }
    assert.equal(next({}), "scene");
    assert.equal(next({ scene: "work" }), "repeat");
    assert.equal(next({ repeat: true }), "repeatDays");
    assert.equal(next({ repeatDays: 7 }), "date");
    assert.equal(next({ date: "", deadlineAsked:true }), "project");
    assert.equal(next({ scene: "life" }), "split");
    assert.equal(next({ scene: "work", projectAsked: true }), "split");
    assert.equal(next({ split: false }), "");
  });

  it("pasting a webpage link is extracted in the conversation instead of becoming a raw title", () => {
    assert.match(assistant, /const firstHttpUrl = text =>/);
    assert.match(assistant, /if \(url\) return beginFromLink\(text, url, source\)/);
    assert.match(assistant, /\/api\/tasks\/extract-link/);
    assert.match(assistant, /正在读取这个链接里的活动信息/);
    assert.match(assistant, /不对可以点上面改/);
    assert.match(assistant, /F\.step = "say"/);
    assert.match(assistant, /if \(queue\.length\) \{ startExtracted\(queue\.shift\(\), queue, true\); return; \}/);
    assert.match(assistant, /opt\("pick-split", "link", "用整理出的步骤"/);
    assert.match(assistant, /applyLinkDraft/);
    // Normal sentences still go through the existing title parser.
    const begin = assistant.slice(assistant.indexOf("async function begin("));
    assert.match(begin, /const parsed = read\(text, now\(\)\)/);
    assert.equal(/beginFromLink[\s\S]*addTask\(/.test(assistant.split("async function beginFromLink")[1].split("async function begin(")[0] || ""), false);
  });

  it("timeline rows have no card frame, show a time and the gap to the previous row", () => {
    assert.match(workspace, /class="ws-tl-time"/);
    assert.match(workspace, /class="ws-tl-gap"/);
    assert.match(workspace, /间隔 /);
    assert.equal(/ws-tl-event tcard/.test(workspace), false);
    assert.match(css, /\.ws-tl-event \{ gap:10px; padding:9px 0; border:0;/);
  });

  it("limits a pull to three distinct pending tasks and returns removed cards to the deck", () => {
    const context = vm.createContext({window: {}});
    vm.runInContext(draw, context);
    const api = context.window.Task.draw;
    const tasks = ["a", "b", "c", "d"].map(id => ({id}));
    const chosen = api.reconcile(tasks, ["b", "b", "missing", "a", "c", "d"]);
    assert.deepEqual(Array.from(chosen), ["b", "a", "c"]);
    assert.deepEqual(Array.from(api.available(tasks, chosen), (card: {id: string}) => card.id), ["d"]);
    assert.deepEqual(Array.from(api.available(tasks, Array.from(chosen).filter(id => id !== "b")), (card: {id: string}) => card.id), ["b", "d"]);
  });
});
