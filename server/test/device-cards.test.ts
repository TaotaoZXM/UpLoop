import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import express from "express";
import { createFakeDb, type SqlParam } from "../src/db/pool.js";
import { createDeviceCardsRouter } from "../src/devices/cards.js";
import { sendError } from "../src/http.js";
import type { AuthedRequest } from "../src/types.js";

const u = "00000000-0000-4000-8000-000000000001";
const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: "任务" + id.slice(-2), project: "未分类", difficulty: "easy", priority: "other", scenario: "life", deadline: "", display: "", reviewRequired: false, important: false, createdAt: "2026-11-20T08:00:00.000Z", plan: null, checklistId: "", ...extra });

function dbWith(state: Record<string, unknown>) {
  let stored = state;
  const flowers = new Map<string, number>();
  const db = createFakeDb((sql, params: SqlParam[]) => {
    if (/FROM user_app_state/.test(sql)) return { rows: stored ? [{ state: stored }] : [], rowCount: stored ? 1 : 0 };
    if (/INSERT INTO user_app_state/.test(sql)) {
      const json = params.find(p => typeof p === "string" && p.startsWith("{"));
      if (json) stored = JSON.parse(String(json));
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT task_id, count FROM task_flowers/.test(sql)) {
      return { rows: [...flowers].map(([task_id, count]) => ({ task_id, count })), rowCount: flowers.size };
    }
    if (/INSERT INTO task_flowers/.test(sql)) {
      const taskId = String(params[1]);
      flowers.set(taskId, (flowers.get(taskId) || 0) + 1);
      return { rows: [{ count: flowers.get(taskId) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return db;
}

function app(db: ReturnType<typeof dbWith>) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as AuthedRequest).user = { id: u, email: "t@example.com", username: "测试", role: "user", token_version: 0, email_verified_at: "yes" } as AuthedRequest["user"]; next(); });
  a.use("/v1/device", createDeviceCardsRouter({ db }));
  a.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => sendError(res, error));
  return a;
}

describe("device cards", () => {
  it("lists open tasks (no repeats) and finished ones, with flower counts", async () => {
    const db = dbWith({ version: 1, todo: [task("a", { deadline: "2026-11-22T18:00", scenario: "work", priority: "important" }), task("b"), task("r", { repeatId: "rep" })], done: [task("d", { completed: Date.now(), display: "11/21 09:00" })], repeatTasks: [], ideas: [], feedback: [], projects: [], expenses: [], routines: [] });
    const server = app(db).listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/device`;
    try {
      const res = await fetch(`${base}/cards`);
      const body = await res.json();
      assert.equal(res.status, 200);
      const ids = body.cards.map((c: { id: string }) => c.id);
      assert.deepEqual(ids, ["a", "b", "d"]);
      assert.equal(body.cards[0].scene, "工作");
      assert.equal(body.cards[0].priority, "重要");
      assert.match(body.cards[0].deadline, /今天|截止/);
      assert.equal(body.cards[0].flowers, 0);
      assert.equal(body.cards[2].done, true);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });

  it("progress increments the flower and returns a praise line", async () => {
    const db = dbWith({ version: 1, todo: [task("a", { title: "写周报" })], done: [], repeatTasks: [], ideas: [], feedback: [], projects: [], expenses: [], routines: [] });
    const server = app(db).listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/device`;
    try {
      const a = await (await fetch(`${base}/cards/a/progress`, { method: "POST" })).json();
      const b = await (await fetch(`${base}/cards/a/progress`, { method: "POST" })).json();
      assert.equal(a.flowers, 1);
      assert.equal(b.flowers, 2);
      assert.ok(b.praise && b.praise.length > 0);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });

  it("done moves the task out of todo and reopen puts it back", async () => {
    const db = dbWith({ version: 1, todo: [task("a", { title: "写周报" })], done: [], repeatTasks: [], ideas: [], feedback: [], projects: [], expenses: [], routines: [] });
    const server = app(db).listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/device`;
    try {
      const done = await (await fetch(`${base}/cards/a/done`, { method: "POST" })).json();
      assert.equal(done.done, true);
      assert.ok(done.praise);
      const cards1 = await (await fetch(`${base}/cards`)).json();
      assert.ok(cards1.cards.some((c: { id: string; done?: boolean }) => c.id === "a" && c.done));
      const reopen = await (await fetch(`${base}/cards/a/done`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reopen: true }) })).json();
      assert.equal(reopen.done, false);
      const cards2 = await (await fetch(`${base}/cards`)).json();
      assert.ok(cards2.cards.some((c: { id: string; done?: boolean }) => c.id === "a" && !c.done));
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });

  it("rejects unknown ids and malformed ids", async () => {
    const db = dbWith({ version: 1, todo: [], done: [], repeatTasks: [], ideas: [], feedback: [], projects: [], expenses: [], routines: [] });
    const server = app(db).listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/device`;
    try {
      assert.equal((await fetch(`${base}/cards/nope/done`, { method: "POST" })).status, 404);
      assert.equal((await fetch(`${base}/cards/${"x".repeat(121)}/progress`, { method: "POST" })).status, 400);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
});

describe("praise loader", () => {
  it("produces a non-empty line for a done event", async () => {
    const db = dbWith({ version: 1, todo: [task("a")], done: [], repeatTasks: [], ideas: [], feedback: [], projects: [], expenses: [], routines: [] });
    const server = app(db).listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/device`;
    try {
      const done = await (await fetch(`${base}/cards/a/done`, { method: "POST" })).json();
      assert.ok(typeof done.praise === "string" && done.praise.length > 1);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
});
