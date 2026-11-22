/**
 * Deployment contract: when UpLoop is mounted under BASE_PATH=/task, every
 * route, asset, session cookie, service worker cache and email link must stay
 * inside that prefix so it does not leak to the host root.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Request, Response } from "express";
import { after, before, describe, it } from "node:test";

// env.ts reads process.env at import time, so configure before dynamic imports.
process.env.JWT_SECRET = "test-jwt-secret-1234567890";
process.env.DEVICE_TOKEN_SECRET = "test-device-secret-1234567890";
process.env.NODE_ENV = "test";
process.env.SERVE_STATIC = "1";
// Deliberately messy: normalisation must accept a trailing slash.
process.env.BASE_PATH = "/task/";

const { createApp } = await import("../src/index.js");
const { env } = await import("../src/env.js");
const { createFakeDb } = await import("../src/db/pool.js");
const { SESSION_COOKIE, writeSessionCookie, clearSessionCookie } = await import("../src/auth/session.js");
const { appHomeUrl } = await import("../src/auth/public-origin.js");

const db = createFakeDb(() => ({ rows: [{ ok: 1 }], rowCount: 1 }));
let server: Server;
let origin = "";

before(async () => {
  server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("BASE_PATH normalisation", () => {
  it("trims slashes and derives the trailing-slash form", () => {
    assert.equal(env.basePath, "/task");
    assert.equal(env.baseUrlPath, "/task/");
  });
});

describe("routes live under the prefix", () => {
  it("serves the API at /task/api/health", async () => {
    const response = await fetch(`${origin}/task/api/health`);
    assert.equal(response.status, 200);
    const data = (await response.json()) as { ok: boolean; service: string };
    assert.equal(data.ok, true);
    assert.equal(data.service, "task");
  });

  it("does not answer at the host root", async () => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 404);
  });

  it("redirects the bare prefix to its slash form", async () => {
    const response = await fetch(`${origin}/task`, { redirect: "manual" });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "/task/");
  });

  it("preserves the query string on that redirect", async () => {
    const response = await fetch(`${origin}/task?login=1`, { redirect: "manual" });
    assert.equal(response.headers.get("location"), "/task/?login=1");
  });
});

describe("the shell carries the prefix", () => {
  it("injects <base> and window.BT_BASE", async () => {
    const response = await fetch(`${origin}/task/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('<base href="/task/">'));
    assert.ok(html.includes('window.BT_BASE="/task/"'));
    // The shell must not reference an unrelated sibling-app prefix.
    assert.equal(html.includes("/taskmanager/"), false);
  });

  it("serves assets from inside the prefix only", async () => {
    const inside = await fetch(`${origin}/task/css/dock.css`);
    assert.equal(inside.status, 200);
    const outside = await fetch(`${origin}/css/dock.css`);
    assert.equal(outside.status, 404);
  });

  it("returns the shell for deep links without swallowing missing assets", async () => {
    const deep = await fetch(`${origin}/task/todo`);
    assert.equal(deep.status, 200);
    assert.ok((await deep.text()).includes('<base href="/task/">'));
    const missing = await fetch(`${origin}/task/js/nope.js`);
    assert.equal(missing.status, 404);
  });
});

describe("session isolation under the app prefix", () => {
  function captureCookie(write: (res: Response) => void) {
    const headers: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
    } as unknown as Response;
    write(res);
    return headers["set-cookie"] || "";
  }
  const req = { secure: true } as unknown as Request;

  it("uses the app-specific cookie name task_session", () => {
    assert.equal(SESSION_COOKIE, "task_session");
  });

  it("scopes the cookie to the app prefix", () => {
    const cookie = captureCookie((res) => writeSessionCookie(req, res, "token"));
    assert.match(cookie, /^task_session=/);
    assert.match(cookie, /Path=\/task(;|$)/);
    assert.match(cookie, /HttpOnly/);
  });

  it("clears the same scoped cookie", () => {
    const cookie = captureCookie((res) => clearSessionCookie(req, res));
    assert.match(cookie, /^task_session=;/);
    assert.match(cookie, /Path=\/task(;|$)/);
    assert.match(cookie, /Max-Age=0/);
  });

  it("builds email links on the prefix, not the shared host root", () => {
    assert.equal(appHomeUrl("https://app.example.com"), "https://app.example.com/task/");
  });
});
