import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";

type Ev = { type: "step" | "done"; name?: string; scene?: string; title?: string; k?: number; total?: number; n?: number; hard?: boolean; plan?: boolean; hour?: number };
type Praise = {
  bestVoice: (list: { name: string; lang: string; localService?: boolean }[]) => { name: string } | null;
  compose: (ev: Ev, rnd?: () => number, hist?: string[]) => string;
  notify: (ev: Ev) => string;
  forChat: (ev: Ev) => { text: string; extra: string; speak: () => void } | null;
  mode: () => string;
  setMode: (m: string) => void;
};

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const web = (f: string) => readFileSync(new URL("../../web/" + f, import.meta.url), "utf8");

function load(opts: { stored?: string | null; speech?: boolean } = {}) {
  const spoken: string[] = [], store: Record<string, string> = opts.stored ? { "task.praise.mode": opts.stored } : {};
  const added: unknown[] = [];
  const doc = {
    readyState: "complete", body: { appendChild: (n: unknown) => added.push(n) },
    addEventListener() {}, querySelectorAll: () => [],
    createElement: () => ({ classList: { add() {}, remove() {} }, setAttribute() {}, querySelector: () => ({}), remove() {} }),
  };
  const context: Record<string, unknown> = {
    window: {}, document: doc, localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
    requestAnimationFrame: (f: () => void) => f(), setTimeout: () => 0, clearTimeout() {},
  };
  if (opts.speech !== false) {
    context.SpeechSynthesisUtterance = function (this: { text: string }, t: string) { this.text = t; };
    (context.window as Record<string, unknown>).speechSynthesis = { cancel() {}, getVoices: () => [], speak: (u: { text: string }) => spoken.push(u.text) };
  }
  vm.createContext(context);
  vm.runInContext(web("js/praise-corpus.js"), context);
  vm.runInContext(web("js/praise.js"), context);
  const Task = (context.window as { Task: { praise: Praise; praiseCorpus: Record<string, string[]> } }).Task;
  return { praise: Task.praise, corpus: Task.praiseCorpus, spoken, store, added };
}

describe("praise corpus", () => {
  const { corpus } = load();
  it("has the pools the picker relies on, each with enough lines to avoid repeats", () => {
    for (const name of ["step", "stepFirst", "stepLast", "done", "planDone", "hard", "first", "three", "many", "morning", "night", "stepNamed", "doneNamed", "work", "life"]) {
      assert.ok(Array.isArray(corpus[name]) && corpus[name].length >= 3, name);
    }
    assert.ok(corpus.step.length >= 10 && corpus.done.length >= 15);
  });
  it("only uses the supported placeholders and has no duplicate lines", () => {
    const all = Object.values(corpus).flat();
    for (const line of all) for (const m of line.matchAll(/\{(\w+)\}/g)) assert.ok(["title", "n", "k", "total", "left", "name"].includes(m[1]), line);
    assert.equal(new Set(all).size, all.length);
  });
});

describe("praise line choice", () => {
  const { praise, corpus } = load();
  const fixed = (v: number) => () => v;
  it("picks a step line for a step and a done line for a finished task", () => {
    const step = praise.compose({ type: "step", title: "写报告", k: 2, total: 5, hour: 14 }, fixed(0.3), []);
    assert.ok(step && !step.includes("{"));
    const done = praise.compose({ type: "done", title: "写报告", n: 2, hour: 14 }, fixed(0.3), []);
    assert.ok(done && !done.includes("{"));
  });
  it("fills placeholders and never leaks a raw one", () => {
    for (let i = 0; i < 200; i++) {
      const t = praise.compose({ type: i % 2 ? "step" : "done", title: i % 3 ? "买菜" : "", k: 2, total: 6, n: 4, hour: i % 24 }, Math.random, []);
      assert.ok(t.length > 0 && !/[{}]/.test(t));
    }
  });
  it("skips lines that need a value that is unknown", () => {
    for (let i = 0; i < 100; i++) {
      const t = praise.compose({ type: "done", hour: 14 }, Math.random, []);
      assert.ok(t && !/任务$/.test(t) && !t.includes("「"), t);
    }
  });
  it("does not repeat any of the last 10 lines", () => {
    const hist: string[] = [], seen: string[] = [];
    for (let i = 0; i < 10; i++) seen.push(praise.compose({ type: "step", title: "x", k: 3, total: 9, hour: 14 }, Math.random, hist));
    assert.equal(new Set(seen).size, seen.length);
  });
  it("still answers when every line has been used", () => {
    const hist = Object.values(corpus).flat();
    assert.ok(praise.compose({ type: "step", title: "x", k: 3, total: 9, hour: 14 }, Math.random, hist));
  });
  it("uses the milestone pools: first step, last step, hard task, finished checklist", () => {
    const only = (pool: string[], ev: Ev) => {
      const seen = new Set<string>();
      for (let i = 0; i < 400; i++) seen.add(praise.compose({ hour: 14, ...ev }, Math.random, []));
      return [...seen].some(t => pool.some(l => t === l.replace(/\{\w+\}/g, m => ({ "{title}": ev.title ?? "", "{n}": String(ev.n), "{k}": String(ev.k), "{total}": String(ev.total), "{left}": String((ev.total ?? 0) - (ev.k ?? 0)) }[m] ?? ""))));
    };
    assert.ok(only(corpus.stepFirst, { type: "step", title: "x", k: 1, total: 4 }));
    assert.ok(only(corpus.stepLast, { type: "step", title: "x", k: 3, total: 4 }));
    assert.ok(only(corpus.hard, { type: "done", title: "x", hard: true, n: 2 }));
    assert.ok(only(corpus.planDone, { type: "done", title: "x", plan: true, n: 2 }));
    assert.ok(only(corpus.first, { type: "done", title: "x", n: 1 }));
  });
  it("mixes in time-of-day lines only in the morning and late night", () => {
    const hit = (hour: number, pool: string[]) => { for (let i = 0; i < 600; i++) if (pool.includes(praise.compose({ type: "done", title: "x", n: 2, hour }, Math.random, []))) return true; return false; };
    assert.ok(hit(7, corpus.morning));
    assert.ok(hit(23, corpus.night));
    assert.equal(hit(14, corpus.morning) || hit(14, corpus.night), false);
  });
});

describe("praise setting and delivery", () => {
  it("defaults to text and persists the choice", () => {
    const a = load();
    assert.equal(a.praise.mode(), "text");
    a.praise.setMode("voice");
    assert.equal(a.store["task.praise.mode"], "voice");
    a.praise.setMode("nonsense");
    assert.equal(a.praise.mode(), "voice");
    assert.equal(load({ stored: "garbage" }).praise.mode(), "text");
  });
  it("shows text without speaking in text mode", () => {
    const a = load({ stored: "text" });
    const t = a.praise.notify({ type: "done", title: "洗衣服", n: 1 });
    assert.ok(t);
    assert.equal(a.spoken.length, 0);
    assert.equal(a.added.length, 1);
  });
  it("speaks the same line in voice mode", async () => {
    const a = load({ stored: "voice" });
    const t = a.praise.notify({ type: "step", title: "洗衣服", k: 1, total: 3 });
    await settle();
    assert.equal(a.spoken.length, 1);
    assert.equal(a.spoken[0], t.replace(/[「」]/g, ""));
  });
  it("does nothing when turned off", () => {
    const a = load({ stored: "off" });
    assert.equal(a.praise.notify({ type: "done", n: 1 }), "");
    assert.equal(a.praise.forChat({ type: "done" }), null);
    assert.equal(a.added.length + a.spoken.length, 0);
  });
  it("still shows text when the browser has no speech synthesis", () => {
    const a = load({ stored: "voice", speech: false });
    assert.ok(a.praise.notify({ type: "done", title: "x", n: 1 }));
  });
  it("gives the AI page a line plus a speaker button", async () => {
    const a = load({ stored: "voice" });
    const p = a.praise.forChat({ type: "done", title: "x", n: 1 });
    assert.ok(p && p.text && p.extra.includes("data-pr-say"));
    p.speak();
    await settle();
    assert.equal(a.spoken.length, 1);
  });
});

describe("praise wiring", () => {
  const index = web("index.html"), dec = web("js/decomposition.js"), ai = web("js/assistant.js"), sw = web("sw.js");
  it("is loaded by the page and precached", () => {
    assert.ok(index.indexOf("praise-corpus.js") > 0 && index.indexOf("praise-corpus.js") < index.indexOf("js/praise.js"));
    assert.ok(index.includes("./css/praise.css"));
    for (const f of ["praise-corpus.js", "praise.js", "praise.css"]) assert.ok(sw.includes(f), f);
  });
  it("fires on finished tasks, checklist steps and AI-page done records", () => {
    assert.ok(/noteSettledTask\(item\.id\);\s*window\.Task\?\.praise\?\.notify\(\{type:'done'/.test(index));
    assert.equal((dec.match(/praiseStep\(/g) || []).length, 2);
    assert.ok(ai.includes('B.praise?.forChat({ type: "done"'));
  });
  it("has the setting on the 我的 page", () => {
    for (const m of ["off", "text", "voice"]) assert.ok(index.includes(`data-pr="${m}"`), m);
  });
});

describe("praise voice choice", () => {
  const { praise } = load();
  it("prefers a natural Mandarin voice over a plain one and ignores non-Chinese voices", () => {
    const v = praise.bestVoice([
      { name: "Alex", lang: "en-US" },
      { name: "Ting-Ting", lang: "zh-CN" },
      { name: "Microsoft Xiaoxiao Online (Natural) - Chinese", lang: "zh-CN", localService: false },
      { name: "Mei-Jia", lang: "zh-TW" },
    ]);
    assert.match(v?.name ?? "", /Xiaoxiao/);
  });
  it("returns null when no Chinese voice is installed", () => {
    assert.equal(praise.bestVoice([{ name: "Alex", lang: "en-US" }]), null);
    assert.equal(praise.bestVoice([]), null);
  });
  it("passes the chosen voice to the speech engine", async () => {
    const spoken: { voice?: { name: string }; lang: string }[] = [];
    const ctx: Record<string, unknown> = {
      window: { speechSynthesis: { cancel() {}, getVoices: () => [{ name: "Google 普通话", lang: "zh-CN" }], speak: (u: { voice?: { name: string }; lang: string }) => spoken.push(u) } },
      document: { readyState: "complete", addEventListener() {}, querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {} },
      SpeechSynthesisUtterance: function (this: Record<string, unknown>, t: string) { this.text = t; },
    };
    vm.createContext(ctx);
    vm.runInContext(web("js/praise-corpus.js"), ctx);
    vm.runInContext(web("js/praise.js"), ctx);
    await (ctx.window as { Task: { praise: Praise & { speak: (t: string) => Promise<string> } } }).Task.praise.speak("你好");
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].voice?.name, "Google 普通话");
  });
});

describe("praise name and scene lines", () => {
  const { praise, corpus } = load();
  it("uses a name line only when a name is known, and scene lines only for work or life", () => {
    const named = new Set<string>(), plain = new Set<string>();
    for (let i = 0; i < 800; i++) {
      named.add(praise.compose({ type: "done", title: "x", n: 2, name: "小明", hour: 14 }, Math.random, []));
      plain.add(praise.compose({ type: "done", title: "x", n: 2, hour: 14 }, Math.random, []));
    }
    assert.ok([...named].some(t => t.includes("小明")));
    assert.ok([...plain].every(t => !t.includes("{") && !/^[，、]/.test(t)));
    const work = new Set<string>();
    for (let i = 0; i < 800; i++) work.add(praise.compose({ type: "done", title: "x", n: 2, scene: "work", hour: 14 }, Math.random, []));
    assert.ok(corpus.work.some(l => work.has(l)));
    const other = new Set<string>();
    for (let i = 0; i < 400; i++) other.add(praise.compose({ type: "done", title: "x", n: 2, scene: "rest", hour: 14 }, Math.random, []));
    assert.ok(![...other].some(t => corpus.work.includes(t) || corpus.life.includes(t)));
  });
  it("truncates a very long name", () => {
    const t = new Set<string>();
    for (let i = 0; i < 800; i++) t.add(praise.compose({ type: "step", title: "x", k: 2, total: 6, name: "一二三四五六七八九十", hour: 14 }, Math.random, []));
    assert.ok([...t].some(x => x.includes("一二三四五六七八")) && ![...t].some(x => x.includes("九")));
  });
});
