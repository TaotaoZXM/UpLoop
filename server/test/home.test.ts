import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";

type Node = { id: string; kind: string; title: string; completed: boolean; deadline?: string; doneAt?: number | null; repeating?: boolean; repeatDay?: string };
type Home = {
  summarize: (nodes: Node[], now: Date) => { open: Node[]; done: Node[]; total: number; late: number; buckets: Record<string, Node[]>; rows: { minute: number; done: boolean; node: Node }[] };
  dueText: (node: Node, now: Date) => string;
  dueMinute: (node: Node) => number | null;
};

const source = readFileSync(new URL("../../web/js/home.js", import.meta.url), "utf8");
function load(): Home {
  const context = vm.createContext({ window: {}, document: { readyState: "complete", querySelector: () => null, addEventListener() {} }, requestAnimationFrame() {} });
  vm.runInContext(source, context);
  return (context as unknown as { window: { Task: { home: Home } } }).window.Task.home;
}
const now = new Date(2026, 10, 19, 14, 20);   // 2026-11-19 14:20
const at = (day: number, h: number, m = 0) => `2026-11-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const task = (id: string, extra: Partial<Node> = {}): Node => ({ id, kind: "task", title: "任务" + id, completed: false, ...extra });

describe("home board summary", () => {
  const home = load();

  it("puts overdue tasks into today and splits the rest by due day", () => {
    const s = home.summarize([
      task("a", { deadline: at(18, 9) }), task("b", { deadline: at(19, 18) }), task("c", { deadline: at(20, 9) }),
      task("d", { deadline: at(25, 9) }), task("e"),
    ], now);
    assert.deepEqual(Array.from(s.buckets.today).map(n => n.id), ["a", "b"]);
    assert.deepEqual(Array.from(s.buckets.tomorrow).map(n => n.id), ["c"]);
    assert.deepEqual(Array.from(s.buckets.later).map(n => n.id), ["d"]);
    assert.deepEqual(Array.from(s.buckets.none).map(n => n.id), ["e"]);
    assert.equal(s.late, 1);   // a is a day late; b is due at 18:00 and it is only 14:20
  });

  it("only counts tasks finished today, and total is finished plus still due today", () => {
    const todayDone = new Date(2026, 10, 19, 10, 30).getTime(), oldDone = new Date(2026, 10, 18, 10, 30).getTime();
    const s = home.summarize([
      task("x", { completed: true, doneAt: todayDone, deadline: at(19, 10, 30) }),
      task("y", { completed: true, doneAt: oldDone }), task("z", { deadline: at(19, 20) }),
    ], now);
    assert.deepEqual(Array.from(s.done).map(n => n.id), ["x"]);
    assert.equal(s.total, 2);
  });

  it("puts only timed tasks of today on the timeline, in clock order, and treats 23:59 as no clock time", () => {
    const s = home.summarize([
      task("late", { deadline: at(19, 20) }), task("any", { deadline: at(19, 23, 59) }), task("early", { deadline: at(19, 9, 15) }),
      task("other", { deadline: at(20, 8) }),
    ], now);
    assert.deepEqual(Array.from(s.rows).map(r => r.node.id), ["early", "late"]);
    assert.equal(home.dueMinute(task("any", { deadline: at(19, 23, 59) })), null);
  });

  it("describes the deadline from now", () => {
    assert.equal(home.dueText(task("a", { deadline: at(19, 18) }), now), "18:00 截止，还有 3 小时 40 分");
    assert.equal(home.dueText(task("b", { deadline: at(19, 9) }), now), "09:00 已过，逾期 5 小时 20 分");
    assert.equal(home.dueText(task("c", { deadline: at(20, 9) }), now), "明天 09:00 截止");
    assert.equal(home.dueText(task("d", { deadline: at(19, 23, 59) }), now), "今天内完成");
    assert.equal(home.dueText(task("e"), now), "");
  });

  it("uses the occurrence day for repeating tasks", () => {
    const s = home.summarize([task("r", { repeating: true, repeatDay: "2026-11-20" })], now);
    assert.deepEqual(Array.from(s.buckets.tomorrow).map(n => n.id), ["r"]);
  });
});

describe("home wiring", () => {
  const read = (file: string) => readFileSync(new URL("../../web/" + file, import.meta.url), "utf8");
  it("loads after workspace.js and draw.js, and is precached", () => {
    const html = read("index.html"), at = (name: string) => html.indexOf('<script defer src="./js/' + name + '"></script>');
    assert.ok(at("draw.js") > -1 && at("home.js") > at("draw.js") && at("home.js") > at("workspace.js"));
    assert.ok(html.includes('href="./css/home.css"'));
    const sw = read("sw.js");
    assert.ok(sw.includes('"./js/home.js"') && sw.includes('"./css/home.css"'));
  });
  it("leaves the Task Pull page alone: it is reached from the My Tasks board, not from the dock", () => {
    const dock = read("js/dock.js");
    assert.ok(dock.includes('label: "Home", screen: "start"'));
    assert.equal(dock.includes('label: "Task Pull"'), false);
    assert.ok(dock.includes('overview: "manage"'));   // while on the pull page the My Tasks slot stays lit
    assert.ok(read("js/home.js").includes('showScreen?.("overview")'));
  });
});
