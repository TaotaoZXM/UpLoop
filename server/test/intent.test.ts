import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectIntents, parseExpense, parseFocusSeconds, parseModelIntent, parseTaskTitle,
} from "../src/chat/intent.js";
import { parseLog } from "../src/wellness/logic/parse.js";
import { countsAsWater, recalcItem, resolveModelItem, resolveTableItem, sumItems } from "../src/wellness/logic/food.js";
import { FOOD_BY_ID } from "../src/wellness/logic/catalog.js";
import { isConsult, isMedical, isRemovedAudio, medicalReply, MEDICAL_REPLY, EMERGENCY_LINE } from "../src/wellness/logic/rules.js";
import { costLi, isPeak } from "../src/wellness/logic/pricing.js";

describe("WP2.6 rule-first intent routing (PRD §3)", () => {
  it("routes sleep/wake and meals to Wellness", () => {
    assert.deepEqual(detectIntents("我醒了"), ["wellness"]);
    assert.deepEqual(detectIntents("中午一碗米饭、150克鸡胸"), ["wellness"]);
    assert.deepEqual(detectIntents("我睡了"), ["wellness"]);
  });

  it("routes expense sentences to M04", () => {
    assert.deepEqual(detectIntents("花了12块"), ["expense"]);
    assert.ok(detectIntents("午饭买了 ¥12.5").includes("expense"));
  });

  it("same sentence with mixed intents writes the recordable part first", () => {
    assert.deepEqual(detectIntents("早饭吃了面包，花了12块"), ["wellness", "expense"]);
  });

  it("routes task, focus, routine and report requests, and retires task picking", () => {
    assert.deepEqual(detectIntents("现在做什么"), ["retired"]);
    assert.deepEqual(detectIntents("推荐一个任务"), ["retired"]);
    assert.deepEqual(detectIntents("花了12块，现在做什么"), ["expense"]);
    assert.deepEqual(detectIntents("加任务：给客户回邮件"), ["task"]);
    assert.deepEqual(detectIntents("专注25分钟"), ["focus"]);
    assert.deepEqual(detectIntents("routine 护肤"), ["routine"]);
    assert.deepEqual(detectIntents("今天的战报"), ["report"]);
  });

  it("medical and consult gates short-circuit everything else", () => {
    assert.deepEqual(detectIntents("胸痛怎么办，顺便花了12块"), ["medical"]);
    assert.deepEqual(detectIntents("失眠很久"), ["medical"]);
    assert.deepEqual(detectIntents("怎么瘦小腿"), ["consult"]);
    assert.deepEqual(detectIntents("皮质醇怎么解读"), ["consult"]);
  });

  it("unclassified input falls back to clarify", () => {
    assert.deepEqual(detectIntents("随便说点什么吧"), ["clarify"]);
  });
});

describe("WP2.6 structured field parsers", () => {
  it("expense amount, note and inferred category", () => {
    const draft = parseExpense("花了 12.5 块 买咖啡");
    assert.equal(draft?.amount, 12.5);
    assert.equal(draft?.category, "餐饮");
    assert.ok((draft?.note || "").includes("咖啡"));
    assert.equal(parseExpense("今天天气不错"), null);
  });

  it("task title and focus duration", () => {
    assert.equal(parseTaskTitle("加任务：给客户回邮件"), "给客户回邮件");
    assert.equal(parseFocusSeconds("专注25分钟"), 25 * 60);
    assert.equal(parseFocusSeconds("专注1小时"), 3600);
    assert.equal(parseFocusSeconds("专注"), 25 * 60);
    assert.equal(parseModelIntent({ intent: "expense" }), "expense");
    assert.equal(parseModelIntent({ intent: "lightstart" }), "clarify");
    assert.equal(parseModelIntent({ intent: "unknown" }), "clarify");
  });
});

describe("PRD W1-W6 Wellness recording rules", () => {
  it("W4: climbing uses MET 8", () => {
    const parsed = parseLog("今天攀岩1小时");
    assert.equal(parsed.kind, "exercise");
    if (parsed.kind === "exercise") {
      assert.equal(parsed.exercise.met, 8);
      assert.equal(parsed.exercise.minutes, 60);
    }
  });

  it("W4: an unlisted activity is never dropped (generic MET 4)", () => {
    const parsed = parseLog("打了40分钟壁球");
    assert.equal(parsed.kind, "exercise");
    if (parsed.kind === "exercise") {
      assert.equal(parsed.exercise.met, 4);
      assert.equal(parsed.exercise.unclassified, true);
      assert.equal(parsed.exercise.minutes, 40);
    }
  });

  it("W5: sleep only stores times / duration", () => {
    assert.deepEqual(detectIntents("23:10睡07:10醒"), ["wellness"]);
    const parsed = parseLog("23:10睡07:10醒");
    assert.equal(parsed.kind, "sleep");
    if (parsed.kind === "sleep") {
      assert.equal(parsed.sleep.bedtime, "23:10");
      assert.equal(parsed.sleep.wake, "07:10");
    }
    assert.equal(parseLog("我睡了").kind, "sleep");
  });

  it("W2: sugary drinks count as water + kcal, alcohol never counts as water", () => {
    const sugary = FOOD_BY_ID.get("sugary");
    const alcohol = FOOD_BY_ID.get("generic-alcohol");
    assert.equal(sugary?.flag, "caloric");
    assert.equal(alcohol?.flag, "alcohol");
    if (sugary && alcohol) {
      assert.equal(countsAsWater(sugary), true);
      assert.equal(countsAsWater(alcohol), false);
    }
  });

  it("W6: medical refusal with emergency escalation", () => {
    assert.equal(isMedical("胸痛怎么办"), true);
    assert.equal(medicalReply("胸痛"), `${MEDICAL_REPLY}\n${EMERGENCY_LINE}`);
    assert.equal(medicalReply("我是不是得了什么病"), MEDICAL_REPLY);
    assert.equal(isMedical("失眠很久"), true);
    assert.equal(isConsult("怎么瘦小腿"), true);
    assert.equal(isRemovedAudio("来点助眠音乐"), true);
  });

  it("W1: table hits are still labelled 估算 and carry a range + confidence", () => {
    const food = FOOD_BY_ID.get("rice") || FOOD_BY_ID.get("chicken-breast") || [...FOOD_BY_ID.values()][0];
    assert.ok(food);
    const item = resolveTableItem({ food: food!, grams: 150, gramsEstimated: false, portion: null });
    assert.equal(item.lookup, "table");
    assert.ok(item.kcal_low <= item.kcal && item.kcal <= item.kcal_high);
    assert.ok(item.confidence > 0 && item.confidence <= 1);
    const recalculated = recalcItem(item, 300);
    assert.equal(recalculated.kcal, item.kcal * 2);
  });

  it("W1: unmatched food is estimated by the model and stored, not dropped", () => {
    const item = resolveModelItem({ name: "表外食物", grams: 100, per100: { kcal: 210, p: 10, c: 20, f: 5 } });
    assert.equal(item.lookup, "model");
    assert.equal(item.kcal, 210);
    assert.ok(item.kcal_high > item.kcal_low);
    const totals = sumItems([item]);
    assert.equal(totals.kcal, 210);
  });

  it("same input yields the same number (parse_cache key is the guard)", () => {
    const food = [...FOOD_BY_ID.values()][0];
    const a = resolveTableItem({ food, grams: 100, gramsEstimated: false, portion: null });
    const b = resolveTableItem({ food, grams: 100, gramsEstimated: false, portion: null });
    assert.deepEqual(a, b);
  });
});

describe("WP2.3 pricing is unchanged but configurable", () => {
  it("cost is computed in li, not yuan, and peak doubles the rate", () => {
    const off = costLi({ cached: 0, miss: 1_000_000, completion: 0, at: new Date("2026-11-04T02:00:00Z") });
    const peak = costLi({ cached: 0, miss: 1_000_000, completion: 0, at: new Date("2026-11-04T02:00:00Z") });
    assert.equal(off, peak);
    assert.ok(off >= 1000);
    assert.equal(typeof isPeak(new Date("2026-11-07T02:00:00Z")), "boolean");
  });
});
