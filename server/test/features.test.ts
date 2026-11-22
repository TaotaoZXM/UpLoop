import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { createApp } from "../src/index.js";
import { env } from "../src/env.js";
import { createFakeDb, type SqlParam } from "../src/db/pool.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { handleChat } from "../src/chat/router.js";
import { recordConfirmed } from "../src/voice/records.js";
import { randomUUID } from "node:crypto";

const user = { id: "11111111-1111-4111-8111-111111111111", email: "features@example.com", token_version: 0, role: "user" };
const profile = { user_id: user.id, gender: "female", water_goal_ml: 1500, birth_ym: "1995-06", cloud_consent: true, onboarded_at: "2026-11-01", pending: { kind: "exercise", text: "跑步30分钟" } };
let current: Record<string, unknown> = { ...profile };
const queries: Array<{ sql: string; params: SqlParam[] }> = [];
const historicNarrative = "健康回顾：喝水1500毫升";
const historicDiary = "我的原始日记，包括喝水的感想。";
const db = createFakeDb((sql, params) => {
  queries.push({ sql, params });
  let rows: Record<string, unknown>[] = [];
  if (/FROM users WHERE id/.test(sql)) rows = [user];
  else if (/FROM user_profile/.test(sql)) rows = [current];
  else if (/INSERT INTO user_profile/.test(sql)) rows = [{ ...current, cloud_consent: params[1], onboarded_at: "now" }];
  else if (/SELECT stats, narrative, diary FROM daily_reports/.test(sql)) rows = [{ stats: { wellness: { waterMl: 1500 }, entryCount: 1 }, narrative: historicNarrative, diary: historicDiary }];
  else if (/SELECT diary FROM daily_reports/.test(sql)) rows = [{ diary: historicDiary }];
  else if (/FROM usage_calls/.test(sql)) rows = [{ li: 0 }];
  else if (/INSERT INTO voice_requests/.test(sql)) rows = [{ request_id: params[1] }];
  else if (/FROM wellness_entries/.test(sql)) rows = [{ id: "water-entry", kind: "water", day: "2026-11-09", water_ml: 300, kcal: 0 }];
  return { rows, rowCount: rows.length };
});
let server: Server;
let origin = "";
const originalEnv = { ...env };
before(async () => {
  Object.assign(env, { wellnessEnabled: false, serveStatic: true, jwtSecret: "feature-test-secret-1234567890", deepseekKey: "", basePath: "", baseUrlPath: "/" });
  server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { Object.assign(env, originalEnv); await new Promise<void>(resolve => server.close(() => resolve())); });
async function call(path: string, method = "GET", body?: unknown) {
  const token = jwt.sign({ sub: user.id, tv: 0 }, env.jwtSecret);
  return fetch(origin + path, { method, headers: { Cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("Wellness suspension and restoration", () => {
  it("injects one capability for the browser and defaults raw shells to suspended", async () => {
    assert.match(await (await fetch(origin)).text(), /window.Task_FEATURES=\{"wellness":false,"taskReflection":false\}/);
    const source = readFileSync(new URL("../../web/js/features.js", import.meta.url), "utf8");
    for (const enabled of [undefined, false, true]) {
      const context: any = { document: { documentElement: { dataset: {} } } };
      context.window = context;
      if (enabled !== undefined) context.Task_FEATURES = { wellness: enabled };
      vm.runInNewContext(source, context);
      assert.equal(context.Task.features.wellness, enabled === true);
      assert.equal(context.document.documentElement.dataset.wellness, String(enabled === true));
    }
  });

  it("blocks manual records, edits, water goals and device summaries before touching health data", async () => {
    for (const [path, method] of [["/api/entries", "POST"], ["/api/entries/id", "DELETE"], ["/api/entries/id/grams", "POST"], ["/api/wellness/day", "GET"], ["/api/wellness/month", "GET"], ["/api/wellness/days/2026-11-09/water-goal", "POST"], ["/v1/summary", "GET"]]) {
      queries.length = 0;
      const response = await call(path, method, method === "POST" ? { kind: "water", ml: 300 } : undefined);
      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error, "feature_disabled");
      assert.equal(queries.some(q => /wellness_entries|wellness_day_settings/.test(q.sql)), false);
    }
    assert.equal((await call("/api/messages")).status, 200);
    const exported = await (await call("/api/export")).json();
    assert.equal(exported.wellnessEntries[0].id, "water-entry");
  });

  it("does not write health records through typed or translated voice requests, including mixed tasks", async () => {
    queries.length = 0;
    const direct = await handleChat({ db }, { userId: user.id, text: "喝了300毫升水" });
    assert.equal(direct.intent, "wellness_disabled");
    const spoken = await recordConfirmed(db, user.id, randomUUID(), "I drank water and need to reply to mail", async () => ({ commands: [
      { action: "record", text: "喝了300毫升水", day: "2026-11-09" },
      { action: "record", text: "加任务：回邮件", day: "2026-11-09" },
    ], clarification: "" }));
    assert.match(spoken.reply, /没有写入健康记录/);
    assert.ok(spoken.cards.some(card => card.type === "task"));
    assert.equal(queries.some(q => /INSERT INTO wellness_entries|UPDATE user_profile SET pending/.test(q.sql)), false);
  });

  it("accepts consent-only onboarding and preserves existing health fields and pending state", async () => {
    queries.length = 0;
    const response = await call("/api/onboarding", "POST", { cloud_consent: false });
    assert.equal(response.status, 200);
    const write = queries.find(q => /INSERT INTO user_profile/.test(q.sql))!;
    assert.deepEqual(write.params, [user.id, false]);
    assert.doesNotMatch(write.sql, /gender|water_goal_ml|birth_ym|pending/);
    assert.equal((await call("/api/profile", "PATCH", { weight_kg: 58 })).status, 403);
    assert.equal((await call("/api/onboarding", "POST", {})).status, 400);
  });

  it("excludes health from reports without overwriting the old narrative or diary", async () => {
    queries.length = 0;
    const response = await call("/api/report?day=2026-11-09");
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.stats.wellnessIncluded, false);
    assert.equal(report.stats.entryCount, 0);
    assert.equal(report.diary, historicDiary);
    assert.notEqual(report.narrative, historicNarrative);
    assert.equal(queries.some(q => /FROM wellness_entries|FROM wellness_day_settings/.test(q.sql)), false);
    assert.match(queries.find(q => /INSERT INTO daily_reports/.test(q.sql))!.sql, /DO NOTHING/);
  });

  it("restores health endpoints and old cached reports, and requires health onboarding only for consent-only accounts", async () => {
    Object.assign(env, { wellnessEnabled: true });
    try {
      assert.match(await (await fetch(origin)).text(), /window.Task_FEATURES=\{"wellness":true,"taskReflection":false\}/);
      assert.equal((await call("/api/wellness/day?day=2026-11-09")).status, 200);
      queries.length = 0;
      assert.equal((await call("/api/entries", "POST", { kind: "water", ml: 300, beverage: "白水", day: "2026-11-09" })).status, 200);
      assert.ok(queries.some(q => /INSERT INTO wellness_entries/.test(q.sql)));
      assert.equal((await (await call("/api/report?day=2026-11-09")).json()).narrative, historicNarrative);
      assert.equal((await (await call("/api/profile")).json()).onboardingRequired, false);
      current = { ...profile, gender: null, water_goal_ml: null, birth_ym: null };
      assert.equal((await (await call("/api/profile")).json()).onboardingRequired, true);
      assert.equal((await call("/api/onboarding", "POST", { cloud_consent: true })).status, 400);
      assert.equal((await call("/api/onboarding", "POST", { gender: "female", water_goal_ml: 1500, birth_ym: "1995-06", cloud_consent: true })).status, 200);
    } finally { Object.assign(env, { wellnessEnabled: false }); current = { ...profile }; }
  });
});
