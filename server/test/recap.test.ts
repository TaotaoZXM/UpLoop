import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";

type Recap = { lead: string; rest: string[]; cheer: string };
const src = readFileSync(new URL("../../web/js/records.js", import.meta.url), "utf8");
const code = src.slice(src.indexOf("/* recap-lines:start */"), src.indexOf("/* recap-lines:end */"));
const run = vm.runInNewContext("(function(){" + code + ";return recapLines;})()") as (n: string, s: object, d: string, t: string) => Recap;
const recap = (n: string, s: object, d = "2026-11-21", t = "2026-11-21"): Recap => JSON.parse(JSON.stringify(run(n, s, d, t)));

describe("AI recap presentation", () => {
  it("drops the date from the headline, highlights task names and adds a cheer line", () => {
    const r = recap("2026年11月21日，你完成了2件小事\n晨间拉伸和给绿萝浇水，还完成了1项日常：晨间护肤。\n这一天留下了2条想法记录。",
      { doneCount: 2, doneTitles: ["晨间拉伸", "给绿萝浇水"], routineTitles: ["晨间护肤"], routineDoneCount: 1, ideaCount: 2 });
    assert.equal(r.lead, "你完成了2件小事");
    assert.equal(r.rest[0], "「晨间拉伸」和「给绿萝浇水」");
    assert.equal(r.rest[1], "还完成了1项日常：「晨间护肤」。");
    assert.equal(r.cheer, "给自己一点掌声。");
    assert.equal([r.lead, ...r.rest].some(t => t.includes("2026")), false);
  });
  it("keeps the template format as is and only the closing line is the cheer", () => {
    const r = recap("今天完成了 2 件事，很扎实。\n「晨间拉伸」和「给绿萝浇水」都已经落了地。\nChecklist 勾掉了 1 项，日常的节奏稳稳接住了。\n还留下 2 个新想法，明天有素材可用。\n给自己一点掌声。",
      { doneCount: 2, doneTitles: ["晨间拉伸", "给绿萝浇水"], routineDoneCount: 1, ideaCount: 2 });
    assert.equal(r.lead, "今天完成了 2 件事，很扎实。");
    assert.equal(r.rest.length, 3);
    assert.equal(r.rest[1], "Checklist 勾掉了 1 项，日常的节奏稳稳接住了。");
    assert.equal(r.rest[0], "「晨间拉伸」和「给绿萝浇水」都已经落了地。");
    assert.equal(r.cheer, "给自己一点掌声。");
  });
  it("adds no cheer on an empty day", () => {
    const r = recap("今天还没有留下记录。\n从最小的一件开始，做完它，这一天就算数了。", { isEmpty: true, doneCount: 0 });
    assert.equal(r.lead, "今天还没有留下记录。");
    assert.equal(r.cheer, "");
    assert.equal(r.rest.length, 1);
  });
  it("splits an old single paragraph into a headline and short lines", () => {
    const r = recap("今天完成了2件事：晨间拉伸和给绿萝浇水，还完成了晨间护肤。另外记下了2个想法。一天里有这样一些小小的动作和念头，挺踏实的。",
      { doneCount: 2, doneTitles: ["晨间拉伸", "给绿萝浇水"], routineTitles: ["晨间护肤"], ideaCount: 2 });
    assert.equal(r.lead, "今天完成了2件事");
    assert.ok(r.rest.length >= 3);
    assert.equal(r.cheer, "给自己一点掌声。");
  });
});
