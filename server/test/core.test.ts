import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isoTimestamp, nowMsIso, readJson } from "../src/db/pool.js";
import { blendedFactor, intervalFor } from "../src/wellness/logic/kb.js";
import { assertNoForbiddenFields } from "../src/profile/routes.js";
import { stripLegacyFields, usableState, validateTaskLimits } from "../src/state/routes.js";
import { amountToCents, inferCategory, normalizeCategory } from "../src/ledger/routes.js";
import { ltreePath, templateSummary } from "../src/memory/summary.js";
import { convertState, expenseFromLegacy, routineFromLegacy, stableHash } from "../scripts/migrate-mysql-to-pg.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("WP1.2 optimistic-lock millisecond precision", () => {
  it("truncates PostgreSQL microsecond timestamps to milliseconds", () => {
    assert.equal(isoTimestamp("2026-11-04T08:12:34.123456Z"), "2026-11-04T08:12:34.123Z");
    assert.equal(isoTimestamp("2026-11-04 08:12:34.123"), "2026-11-04T08:12:34.123Z");
    assert.equal(isoTimestamp("not-a-date"), null);
  });

  it("every generated timestamp survives a round trip unchanged", () => {
    const written = nowMsIso(new Date("2026-11-04T08:12:34.123Z"));
    assert.equal(isoTimestamp(written), written);
    assert.match(written, /\.\d{3}Z$/);
  });

  it("readJson handles both jsonb objects and legacy strings", () => {
    assert.deepEqual(readJson('{"a":1}', {}), { a: 1 });
    assert.deepEqual(readJson({ a: 1 }, {}), { a: 1 });
    assert.deepEqual(readJson("broken", { fallback: true }), { fallback: true });
  });
});

describe("WP1.4 server-side task caps and legacy field stripping", () => {
  const makeState = (todo: Array<Record<string, unknown>>) => ({ version: 1, todo, done: [], ideas: [] });

  it("accepts a document within the caps", () => {
    const state = makeState([
      ...Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, difficulty: "easy" })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, difficulty: "medium" })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `h${i}`, difficulty: "hard" })),
    ]);
    assert.equal(usableState(state), true);
    assert.equal(validateTaskLimits(state), null);
  });

  it("allows more than 10 open tasks", () => {
    const state = makeState(Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, difficulty: "easy" })));
    assert.equal(validateTaskLimits(state), null);
  });

  it("does not apply the removed per-difficulty caps", () => {
    assert.equal(validateTaskLimits(makeState(Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, difficulty: "easy" })))), null);
  });

  it("accepts one-day repeat rules and validates their scene", () => {
    assert.equal(validateTaskLimits({ version: 1, repeatTasks: [{ id: "r1", title: "喝水", repeatDays: 1, startDay: "2026-11-11", scenario: "life" }] }), null);
    assert.match(validateTaskLimits({ version: 1, done: [{ id: "d1", scenario: "other" }] }) || "", /场景/);
  });

  it("counts overlapping repeat dates without charging expired series", () => {
    const rules = Array.from({ length: 11 }, (_, index) => ({ id: `r${index}`, title: "重复", repeatDays: 3, startDay: "2099-01-01", scenario: "work" }));
    assert.equal(validateTaskLimits({ version: 1, repeatTasks: rules }), null);
    const separated = rules.map((rule, index) => ({ ...rule, startDay: `2099-${String(index + 1).padStart(2, "0")}-01` }));
    assert.equal(validateTaskLimits({ version: 1, repeatTasks: separated }), null);
    assert.equal(validateTaskLimits({ version: 1, todo: Array.from({length:10}, (_, index) => ({id:`t${index}`})), repeatTasks: [{ ...rules[0], startDay: "2000-01-01" }] }), null);
    for (const invalid of [{...rules[0], startDay:"2099-02-30"}, {...rules[0], repeatDays:0}, {...rules[0], repeatDays:1.5}, {...rules[0], repeatDays:366}]) {
      assert.match(validateTaskLimits({version:1, repeatTasks:[invalid]}) || "", /循环任务/);
    }
  });

  it("old PWA payload cannot overwrite split tables", () => {
    const state = { version: 1, todo: [], expenses: [{ amount: "12.5" }], routines: [{ title: "护肤", done: true }] };
    const result = stripLegacyFields(state);
    assert.deepEqual(result.ignoredFields, ["expenses", "routines"]);
    assert.equal("expenses" in result.state, false);
    assert.equal("routines" in result.state, false);
    assert.equal(state.expenses.length, 1, "input is not mutated");
  });
});

describe("WP2.2 onboarding forbids goals and medical fields", () => {
  it("rejects goals / medical_history / medications / age_band", () => {
    for (const field of ["goals", "goal", "medical_history", "medications", "age_band", "birth_year"]) {
      assert.match(assertNoForbiddenFields({ [field]: "x" })?.message || "", new RegExp(field));
    }
    assert.equal(assertNoForbiddenFields({ gender: "female", water_goal_ml: 1500 }), null);
  });

  it("no goals column exists in the schema", () => {
    const sql = readFileSync(join(root, "server", "src", "db", "migrations", "001_init.sql"), "utf8");
    // Comments may explain why goals are forbidden; what matters is the column.
    assert.equal(/^\s*(goals|goals_json)\s+(text|jsonb|integer|numeric)/im.test(sql), false);
  });
});

describe("WP3.1 knowledge base ranges and personal corrections", () => {
  it("table hits are narrow, model estimates are wide", () => {
    const table = intervalFor("table", 200);
    const model = intervalFor("model", 200);
    assert.ok(model.kcal_high - model.kcal_low > table.kcal_high - table.kcal_low);
    assert.ok(model.confidence < table.confidence);
  });

  it("correction factor stays within 0.5-2.0 and blends gradually", () => {
    const first = blendedFactor(1, 1.6, 0);
    const later = blendedFactor(first, 1.6, 3);
    assert.ok(first >= 0.5 && first <= 2);
    assert.ok(later > first && later <= 2);
    // One confirmation moves at most half the distance, even for an extreme sample.
    assert.ok(blendedFactor(1, 99, 20) > 1 && blendedFactor(1, 99, 20) <= 2);
    assert.ok(blendedFactor(1, 0.01, 20) < 1 && blendedFactor(1, 0.01, 20) >= 0.5);
  });

  it("day-node path is a valid ltree label chain", () => {
    assert.match(ltreePath("2026-11-04"), /^y\d{4}\.w\d{1,2}\.d\d{8}$/);
    assert.match(templateSummary({
      day: "2026-11-04", isEmpty: true,
    } as never), /没有留下记录/);
  });
});

describe("WP1.4 / M04-F1 money and categories", () => {
  it("stores integer cents, never floats", () => {
    assert.equal(amountToCents("12.5"), 1250);
    assert.equal(amountToCents(0), null);
    assert.equal(amountToCents("abc"), null);
  });

  it("category set is fixed and assistant inference is optional", () => {
    assert.equal(normalizeCategory("餐饮"), "餐饮");
    assert.equal(normalizeCategory("随便写的"), null);
    assert.equal(inferCategory("打车去公司"), "交通");
    assert.equal(inferCategory("随便"), null);
  });
});

describe("WP1.2 migration helpers", () => {
  it("state is split without losing other fields", () => {
    const raw = { version: 1, todo: [{ id: "a" }], expenses: [{ amount: "12.5" }], routines: [{ title: "护肤", done: true }] };
    const { clean, expenses, routines } = convertState(raw);
    assert.deepEqual(clean.todo, [{ id: "a" }]);
    assert.equal("expenses" in clean, false);
    assert.equal(expenses.length, 1);
    assert.equal(routines.length, 1);
  });

  it("jsonb key reordering does not create a false reconciliation mismatch", () => {
    assert.equal(stableHash({ a: 1, b: { x: 2, y: 3 } }), stableHash({ b: { y: 3, x: 2 }, a: 1 }));
  });

  it("legacy expense string becomes cents with a Beijing business day", () => {
    const expense = expenseFromLegacy({ amount: "12.5", note: "午饭", createdAt: "2026-11-04T02:00:00.000Z" }, "u1");
    assert.equal(expense?.amountCents, 1250);
    assert.equal(expense?.day, "2026-11-04");
    assert.equal(expense?.source, "migrated");
    assert.equal(expenseFromLegacy({ amount: "0" }, "u1"), null);
  });

  it("old routine done:true is never migrated as a day check", () => {
    const routine = routineFromLegacy({ title: "护肤", done: true }, "u1", 0);
    assert.equal(routine?.title, "护肤");
    assert.equal("done" in (routine || {}), false);
    assert.equal("day" in (routine || {}), false);
  });
});
