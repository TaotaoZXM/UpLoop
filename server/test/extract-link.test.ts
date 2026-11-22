import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { createFakeDb } from "../src/db/pool.js";
import { env } from "../src/env.js";
import {
  assertPublicHttpUrl,
  createExtractLinkRouter,
  extractHttpUrls,
  htmlToText,
  isBlockedHostname,
  isPrivateOrLocalAddress,
  mapExtractedEvent,
  mapExtractedEvents,
  looksBlockedOrEmpty,
  type ExtractedEvent,
} from "../src/tasks/extract-link.js";

const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];

describe("URL detection and SSRF guards", () => {
  it("finds a plain URL or one mixed with short text, and trims punctuation", () => {
    assert.deepEqual(extractHttpUrls("https://example.com/event"), ["https://example.com/event"]);
    assert.deepEqual(
      extractHttpUrls("看看这个活动 https://mp.weixin.qq.com/s/abcxyz 帮我记一下。"),
      ["https://mp.weixin.qq.com/s/abcxyz"],
    );
    assert.deepEqual(extractHttpUrls("链接是 https://www.xiaohongshu.com/explore/123。"), ["https://www.xiaohongshu.com/explore/123"]);
    assert.equal(extractHttpUrls("买菜做饭，顺便整理房间").length, 0);
    assert.equal(extractHttpUrls("ftp://example.com/x").length, 0);
  });

  it("blocks localhost, private and metadata addresses", () => {
    assert.equal(isPrivateOrLocalAddress("127.0.0.1"), true);
    assert.equal(isPrivateOrLocalAddress("10.1.2.3"), true);
    assert.equal(isPrivateOrLocalAddress("192.168.0.8"), true);
    assert.equal(isPrivateOrLocalAddress("172.16.5.1"), true);
    assert.equal(isPrivateOrLocalAddress("169.254.169.254"), true);
    assert.equal(isPrivateOrLocalAddress("::1"), true);
    assert.equal(isPrivateOrLocalAddress("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateOrLocalAddress("203.0.113.10"), false);
    assert.equal(isBlockedHostname("localhost"), true);
    assert.equal(isBlockedHostname("metadata.google.internal"), true);
    assert.equal(isBlockedHostname("127.0.0.1"), true);
    assert.equal(isBlockedHostname("example.com"), false);
  });

  it("rejects non-public URLs before any fetch", async () => {
    await assert.rejects(() => assertPublicHttpUrl("ftp://example.com/x", publicLookup), /http 或 https/);
    await assert.rejects(() => assertPublicHttpUrl("http://localhost/event", publicLookup), /内网或本机/);
    await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/event", publicLookup), /内网或本机/);
    await assert.rejects(
      () => assertPublicHttpUrl("https://evil.example/x", async () => [{ address: "127.0.0.1", family: 4 }]),
      /内网或本机/,
    );
    const ok = await assertPublicHttpUrl("https://example.com/talk", publicLookup);
    assert.equal(ok.hostname, "example.com");
  });
});

describe("HTML stripping and field mapping", () => {
  it("strips scripts and reads the title", () => {
    const page = htmlToText(`<html><head><title>周末市集</title><script>document.cookie="x"</script></head><body><p>时间：2026年11月22日 14:00</p></body></html>`);
    assert.equal(page.title, "周末市集");
    assert.match(page.text, /2026年11月22日/);
    assert.equal(page.text.includes("document.cookie"), false);
  });

  it("maps extracted fields into the existing task draft shape and drops a rest scene", () => {
    const event = mapExtractedEvent({
      title: "社区秋季市集",
      date: "2026-11-22",
      time: "14:00",
      scene: "rest",
      priority: "important",
      location: "河边公园",
      signup: "现场登记",
      organizer: "街道办",
      steps: ["带环保袋"],
      confidence: "high",
    });
    assert.ok(event);
    assert.equal(event.title, "社区秋季市集");
    assert.equal(event.date, "2026-11-22");
    assert.equal(event.time, "14:00");
    assert.equal(event.scene, "");
    assert.equal(event.priority, "important");
    assert.ok(event.steps.includes("到场：河边公园"));
    assert.ok(event.steps.includes("报名：现场登记"));
    assert.ok(event.steps.includes("主办：街道办"));
    assert.ok(event.steps.includes("带环保袋"));
    assert.equal(mapExtractedEvent({ title: "" }), null);
    assert.equal(mapExtractedEvent({ title: "讲座", date: "2026-13-40" })?.date, "");
    assert.deepEqual(mapExtractedEvents({ events: [{ title: "A" }, { title: "" }, { title: "B" }] }).map((row) => row.title), ["A", "B"]);
  });

  it("leaves optional fields empty when the model is uncertain", () => {
    const event = mapExtractedEvent({ title: "读书会", scene: "maybe", priority: "high", repeat: "weekly" });
    assert.ok(event);
    assert.equal(event.scene, "");
    assert.equal(event.priority, "");
    assert.equal(event.repeat, null);
    assert.equal(event.review, null);
    assert.equal(event.project, "");
  });

  it("recognizes a login wall or empty page", () => {
    assert.match(looksBlockedOrEmpty("请登录", "请在微信中打开", 200) || "", /登录/);
    assert.match(looksBlockedOrEmpty("", "", 403) || "", /登录/);
    assert.equal(looksBlockedOrEmpty("社区秋季市集", "活动将于2026年11月22日下午在河边公园举办，欢迎邻里邻居一起来逛市集、吃小吃。", 200), null);
  });
});

describe("extract-link API", () => {
  let server: ReturnType<express.Express["listen"]>, base: string, consent = true;
  const originalKey = env.deepseekKey;
  let pages: Record<string, { status: number; body: string; type?: string }> = {};
  let modelPayload: { events: Array<Record<string, unknown>> } = { events: [] };
  let fetched: string[] = [];
  const html = `<html><head><title>社区秋季市集</title></head><body><p>2026年11月22日 14:00 在河边公园举办市集，现场登记即可参加。</p></body></html>`;

  before(async () => {
    const db = createFakeDb((sql) => ({
      rows: /FROM user_profile/.test(sql) ? [{ cloud_consent: consent }] : /FROM usage_calls/.test(sql) ? [{ li: 0, tokens: 0, calls: 0 }] : [],
      rowCount: 1,
    }));
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith(base)) return fetch(input);
      fetched.push(url);
      const page = pages[new URL(url).hostname] || pages["*"] || { status: 404, body: "" };
      return new Response(page.body, { status: page.status, headers: { "content-type": page.type || "text/html; charset=utf-8" } });
    };
    const chat = async () => JSON.stringify(modelPayload);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as express.Request & { user?: { id: string } }).user = { id: "owner" }; next(); });
    app.use(createExtractLinkRouter({ db }, { fetchImpl, lookup: publicLookup, chat }));
    app.use((err: { status?: number; code?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status || 500).json({ error: err.code, message: err.message });
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    Object.assign(env, { deepseekKey: "test-key" });
  });
  after(() => {
    Object.assign(env, { deepseekKey: originalKey });
    server.close();
  });
  const post = (body: unknown) => fetch(base + "/tasks/extract-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("returns mapped events from a mocked public page", async () => {
    fetched = [];
    pages = { "*": { status: 200, body: html } };
    modelPayload = { events: [{ title: "社区秋季市集", date: "2026-11-22", time: "14:00", scene: "life", location: "河边公园", confidence: "high" }] };
    const response = await post({ url: "https://example.com/market", note: "帮我记一下 https://example.com/market" });
    assert.equal(response.status, 200);
    const body = await response.json() as { events: ExtractedEvent[] };
    assert.equal(body.events[0].title, "社区秋季市集");
    assert.equal(body.events[0].date, "2026-11-22");
    assert.equal(body.events[0].time, "14:00");
    assert.equal(body.events[0].scene, "life");
    assert.ok(body.events[0].steps.some((step) => step.includes("河边公园")));
    assert.equal(fetched.some((url) => url.includes("127.0.0.1") && !url.startsWith(base)), false);
  });

  it("fails clearly when the page is a login wall, without crashing", async () => {
    pages = { "*": { status: 403, body: "<html><title>请登录</title><body>请在微信中打开</body></html>" } };
    const response = await post({ url: "https://mp.weixin.qq.com/s/abc" });
    assert.equal(response.status, 422);
    const body = await response.json() as { message: string };
    assert.match(body.message, /登录|文字贴过来/);
  });

  it("rejects localhost targets and a missing AI key, and requires consent", async () => {
    const blocked = await post({ url: "http://127.0.0.1:8900/secret" });
    assert.equal(blocked.status, 400);
    consent = false;
    assert.equal((await post({ url: "https://example.com/market" })).status, 403);
    consent = true;
    Object.assign(env, { deepseekKey: "" });
    assert.equal((await post({ url: "https://example.com/market" })).status, 503);
    Object.assign(env, { deepseekKey: "test-key" });
  });
});
