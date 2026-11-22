import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeDb } from "../src/db/pool.js";
import { computeReportStats, recordDay } from "../src/report/routes.js";
import { validateTaskLimits } from "../src/state/routes.js";
import { env } from "../src/env.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";

describe("workspace relationships and daily summary", () => {
  it("uses Shanghai dates and skips undated or invalid legacy records", () => {
    assert.equal(recordDay("2026-11-09T16:05:00Z"), "2026-11-10");
    assert.equal(recordDay(Date.parse("2026-11-10T02:00:00Z")), "2026-11-10");
    assert.equal(recordDay(String(Date.parse("2026-11-10T02:00:00Z"))), "2026-11-10");
    for (const value of [undefined, null, "", "invalid"]) assert.equal(recordDay(value), null);
  });
  it("counts only selected-day tasks and ideas and includes routine-only days", async () => {
    const original = env.wellnessEnabled;
    Object.assign(env, { wellnessEnabled: false });
    const state = { done: [
      { title: "今天完成", completed: Date.parse("2026-11-09T16:05:00Z") },
      { title: "昨天完成", completed: Date.parse("2026-11-09T10:00:00Z") },
      { title: "无日期" },
    ], ideas: [{ text: "今天灵感", createdAt: "2026-11-10T10:00:00+08:00" }, { text: "昨天灵感", createdAt: "2026-11-09T00:00:00Z" }, { text: "无日期" }] };
    const db = createFakeDb((sql, params) => {
      assert.equal(params[0], "owner");
      let rows: Record<string, unknown>[] = [];
      if (/FROM user_app_state/.test(sql)) rows = [{ state }];
      else if (/SELECT r.title FROM routine_checks/.test(sql)) rows = [{ title: "整理桌面" }];
      else if (/COUNT\(\*\) AS count FROM routine_checks/.test(sql)) rows = [{ count: 1 }];
      return { rows, rowCount: rows.length };
    });
    try {
      const today = await computeReportStats(db, "owner", "2026-11-10");
      assert.equal(today.doneCount, 1);
      assert.deepEqual(today.doneTitles, ["今天完成"]);
      assert.equal(today.ideaCount, 1);
      assert.equal(today.routineDoneCount, 1);
      assert.deepEqual(today.routineTitles, ["整理桌面"]);
      state.done = []; state.ideas = [];
      const routineOnly = await computeReportStats(db, "owner", "2026-11-10");
      assert.equal(routineOnly.isEmpty, false);
    } finally { Object.assign(env, { wellnessEnabled: original }); }
  });
  it("validates typed links, rejects malformed records and permits old state without links", () => {
    const link = { id: "a", from: "task:t1", to: "idea:i1", kind: "inspires" };
    assert.equal(validateTaskLimits({ version: 1, links: [link] }), null);
    assert.equal(validateTaskLimits({ version: 1 }), null);
    for (const links of [null, [{}], [{ ...link, to: link.from }], [link, link], [{ ...link, kind: "invented" }], [{ ...link, from: "foreign" }]]) {
      assert.ok(validateTaskLimits({ version: 1, links }));
    }
  });
  it("preserves concurrent links through the existing state merge", () => {
    const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    const source = html.slice(html.indexOf("function sameJson("), html.indexOf("function appStateSignature("));
    const merge = vm.runInNewContext(source + ";mergeAppState", { JSON, Set, Map, Array, Object, Date, String });
    const base = { version: 1, links: [{ id: "a", from: "task:1", to: "idea:1", kind: "related" }] };
    const local = { ...base, links: [...base.links, { id: "b", from: "task:2", to: "idea:2", kind: "supports" }] };
    const server = { ...base, links: [...base.links, { id: "c", from: "task:3", to: "idea:3", kind: "related" }] };
    assert.deepEqual(Array.from(merge(base, local, server).links, (item: any) => item.id), ["a", "c", "b"]);
    assert.deepEqual(Array.from(merge(base, { ...base, links: [] }, server).links, (item: any) => item.id), ["c"]);
  });
  it("renders the existing timeline on Manage All instead of Overview", () => {
    const source = readFileSync(new URL("../../web/js/workspace.js", import.meta.url), "utf8");
    const overviewHtml = source.match(/root\.id = "overviewScreen"[\s\S]*?root\.innerHTML = ([^;]+);/)?.[1] || "";
    const allHtml = source.match(/board\.id = "allScreen"[\s\S]*?board\.innerHTML = ([^;]+);/)?.[1] || "";
    assert.match(overviewHtml, /Task Pull/);
    assert.doesNotMatch(overviewHtml, /ws-timeline|wsContent|wsSearch|wsMonth/);
    assert.match(allHtml, /ws-timeline/);
    assert.match(allHtml, /id="wsContent"/);
    assert.match(allHtml, /ws-tools-row[\s\S]*wsSearch[\s\S]*ws-month/);
    assert.match(source, /\["home","今天"\],\["todo","To-do"\],\["done","Done"\],\["routine","Checklist"\]/);
    assert.match(source, /if \(active === "all"\) \{ render\(\); loadTimelineRoutines\(\); \}/);
  });
});
