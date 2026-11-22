/** §10 API tests: unauthenticated 401, onboarding 403, parameter boundaries,
 *  quota soft stop, physiology stub, CORS allowlist and privacy. No real DB. */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { SqlParam } from "../src/db/pool.js";
import { after, before, describe, it } from "node:test";

// env.ts reads process.env at import time, so configure before dynamic imports.
process.env.JWT_SECRET = "test-jwt-secret-1234567890";
process.env.DEVICE_TOKEN_SECRET = "test-device-secret-1234567890";
process.env.NODE_ENV = "test";
process.env.V1_CORS_ORIGINS = "";

const { createApp } = await import("../src/index.js");
const { env } = await import("../src/env.js");
const { createFakeDb } = await import("../src/db/pool.js");
const { createDeviceToken } = await import("../src/devices/routes.js");
const { hashDeviceToken, DEVICE_PREFIX, SESSION_COOKIE } = await import("../src/auth/session.js");
const jwt = (await import("jsonwebtoken")).default;
const { createHash } = await import("node:crypto");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const userRow = {
  id: USER_ID, email: "tao@example.com", username: "桃桃",
  email_verified_at: "2026-11-01T00:00:00.000Z", token_version: 0, role: "user",
};

let profileRow: Record<string, unknown> = {
  user_id: USER_ID, gender: "female", water_goal_ml: 1500, birth_ym: "1995-06",
  weight_kg: null, weight_skipped: false, cloud_consent: true,
  onboarded_at: "2026-11-01T00:00:00.000Z", pending: null,
  updated_at: "2026-11-01T00:00:00.000Z",
};
let usageLi = 0;
let stateRow: Record<string, unknown> | null = null;
let lastSql = "";
const captured: Record<string, SqlParam[]> = {};

function rows(sql: string, params: SqlParam[]) {
  lastSql = sql;
  if (/INSERT INTO device_tokens/.test(sql)) captured.device = params;
  if (/UPDATE user_app_state|INSERT INTO user_app_state/.test(sql)) captured.state = params;
  if (/SELECT 1/.test(sql)) return { rows: [], rowCount: 0 };
  if (/FROM users WHERE id = \$1 LIMIT 1/.test(sql)) return { rows: [userRow], rowCount: 1 };
  if (/FROM device_tokens WHERE token_hash/.test(sql)) return { rows: [], rowCount: 0 };
  if (/FROM user_profile WHERE user_id = \$1 LIMIT 1/.test(sql)) {
    return { rows: [profileRow], rowCount: 1 };
  }
  if (/INSERT INTO user_profile/.test(sql)) return { rows: [profileRow], rowCount: 1 };
  if (/FROM user_app_state WHERE user_id = \$1/.test(sql)) {
    return { rows: stateRow ? [stateRow] : [], rowCount: stateRow ? 1 : 0 };
  }
  if (/FROM usage_calls/.test(sql)) {
    return { rows: [{ li: usageLi, tokens: 0, calls: 0 }], rowCount: 1 };
  }
  if (/SELECT \* FROM expenses|FROM wellness_entries|FROM chat_messages|FROM routines|FROM focus_sessions|FROM daily_reports|FROM personal_foods|FROM routine_checks|FROM memory_nodes|FROM life_events|FROM profile_facts/.test(sql)) {
    return { rows: [], rowCount: 0 };
  }
  if (/FROM daily_reports WHERE user_id/.test(sql)) return { rows: [], rowCount: 0 };
  if (/COALESCE\(SUM/.test(sql)) return { rows: [{ cents: 0, seconds: 0, count: 0 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

const db = createFakeDb((sql, params) => rows(sql, params));
let server: Server;
let base = "";

before(async () => {
  server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function cookie() {
  const token = jwt.sign({ sub: USER_ID, email: userRow.email, tv: 0 }, env.jwtSecret, { expiresIn: "7d" });
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function call(path: string, options: RequestInit & { auth?: boolean } = {}) {
  const { auth, ...rest } = options;
  const headers = new Headers(rest.headers || {});
  if (auth) headers.set("Cookie", cookie());
  if (rest.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(base + path, { ...rest, headers });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, headers: response.headers };
}

describe("public endpoints", () => {
  it("health check reflects the injected pool", async () => {
    const { status, data } = await call("/api/health");
    assert.equal(status, 200);
    assert.equal((data as { ok: boolean }).ok, true);
    assert.match(lastSql, /SELECT 1|catalog|FROM/);
  });

  it("P1/P2: exactly one empty physiology stub, no real readings", async () => {
    const { status, data } = await call("/api/physiology");
    const stub = data as Record<string, unknown>;
    assert.equal(status, 200);
    assert.equal(stub.enabled, false);
    assert.equal(stub.spo2, null);
    assert.equal(stub.heartRate, null);
    assert.equal(stub.stress, null);
  });
});

describe("authentication boundaries (§10)", () => {
  for (const [method, path] of [
    ["GET", "/api/state"], ["GET", "/api/export"], ["GET", "/api/profile"],
    ["POST", "/api/chat"], ["POST", "/v1/chat"], ["GET", "/api/wellness/day"], ["GET", "/api/voice/config"], ["POST", "/api/voice/records"], ["GET", "/v1/voice/config"],
  ] as const) {
    it(`${method} ${path} -> 401 when not logged in`, async () => {
      const { status } = await call(path, { method, body: method === "POST" ? "{}" : undefined });
      assert.equal(status, 401);
    });
  }

  it("WP2.5: /v1 no longer uses wildcard CORS", async () => {
    const { headers } = await call("/v1/chat", {
      method: "POST", body: "{}", headers: { Origin: "https://evil.example" },
    });
    assert.equal(headers.get("access-control-allow-origin"), null);
  });

  it("POST task decomposition requires a logged-in account", async () => {
    const { status } = await call("/api/tasks/decompose", { method: "POST", body: JSON.stringify({title:"办签证"}) });
    assert.equal(status, 401);
  });

  it("a non-admin cannot read the back-office usage endpoint", async () => {
    const { status } = await call("/api/admin/usage", { auth: true });
    assert.equal(status, 403);
  });
});

describe("WP1.4 state boundaries", () => {
  it("GET returns a millisecond optimistic-lock token", async () => {
    stateRow = { state: { version: 1, todo: [], done: [] }, updated_at: "2026-11-04T08:00:00.123456Z" };
    const { status, data } = await call("/api/state", { auth: true });
    assert.equal(status, 200);
    assert.equal((data as { updatedAt: string }).updatedAt, "2026-11-04T08:00:00.123Z");
  });

  it("PUT allows more than 10 tasks", async () => {
    stateRow = null;
    const todo = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, difficulty: "easy" }));
    const { status, data } = await call("/api/state", {
      auth: true, method: "PUT",
      body: JSON.stringify({ state: { version: 1, todo, done: [] } }),
    });
    assert.equal(status, 200);
    assert.equal((data as {state:{todo:unknown[]}}).state.todo.length,11);
  });

  it("PUT ignores legacy expenses/routines instead of overwriting split tables", async () => {
    stateRow = null;
    const { status, data } = await call("/api/state", {
      auth: true, method: "PUT",
      body: JSON.stringify({
        state: { version: 1, todo: [], expenses: [{ amount: "12.5" }], routines: [{ title: "护肤" }] },
      }),
    });
    assert.equal(status, 200);
    assert.deepEqual((data as { ignoredFields: string[] }).ignoredFields, ["expenses", "routines"]);
    const persisted = JSON.parse(String(captured.state?.[1] || "{}"));
    assert.equal("expenses" in persisted, false);
    assert.equal("routines" in persisted, false);
  });
});

describe("WP2.2 / F-S5 gates", () => {
  it("onboarding rejects a goals field (PRD B1)", async () => {
    const { status, data } = await call("/api/onboarding", {
      auth: true, method: "POST",
      body: JSON.stringify({ gender: "female", water_goal_ml: 1500, birth_ym: "1995-06", cloud_consent: true, goals: ["减脂"] }),
    });
    assert.equal(status, 400);
    assert.equal((data as { error: string }).error, "forbidden_field");
  });

  it("chat returns 403 onboarding_required before any model call", async () => {
    profileRow = { ...profileRow, onboarded_at: null };
    const { status, data } = await call("/api/chat", {
      auth: true, method: "POST", body: JSON.stringify({ text: "我醒了" }),
    });
    assert.equal(status, 403);
    assert.equal((data as { error: string }).error, "onboarding_required");
    profileRow = { ...profileRow, onboarded_at: "2026-11-01T00:00:00.000Z" };
  });

  it("B4/S-W9: over-quota chat soft-stops with a fixed sentence and no numbers", async () => {
    usageLi = 50 * 1000;
    const { status, data } = await call("/api/chat", {
      auth: true, method: "POST", body: JSON.stringify({ text: "我醒了" }),
    });
    assert.equal(status, 200);
    const body = data as { reply: string; intent: string; blocked: boolean };
    assert.equal(body.reply, "本月额度已用完，对话已暂停");
    assert.equal(body.blocked, true);
    // The reply itself carries no number or RMB symbol; `day` is a calendar date.
    assert.equal(/\d|¥|\$|usage|yuan|cost/i.test(body.reply), false);
    assert.equal("usage" in body, false);
    usageLi = 0;
  });
});

describe("WP2.5 device tokens", () => {
  it("plaintext is taskr_ + 48 hex, returned once, and only a hash is stored", async () => {
    const created = await createDeviceToken(db, USER_ID, "小方屏");
    assert.match(created.token, /^taskr_[0-9a-f]{48}$/);
    assert.ok(created.tokenPrefix.startsWith(DEVICE_PREFIX));
    const storedHash = String(captured.device?.[2] || "");
    assert.notEqual(storedHash, created.token);
    assert.equal(storedHash, hashDeviceToken(created.token));
    assert.equal(storedHash.length, 64);
    assert.equal(createHash("sha256").update(`${env.deviceTokenSecret}${created.token}`).digest("hex"), storedHash);
  });
});
