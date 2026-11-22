import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import express from "express";
import { createFakeDb, type SqlParam } from "../src/db/pool.js";
import { speechText, synthesize } from "../src/voice/tts.js";
import { createVoiceService } from "../src/voice/routes.js";
import { sendError } from "../src/http.js";
import { env } from "../src/env.js";
import type { AuthedRequest } from "../src/types.js";

const wavBytes = () => { const b = Buffer.alloc(64); b.write("RIFF", 0); b.write("WAVE", 8); return b; };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const base = { text: "干得好", key: "secret-key", base: "https://dashscope.example/api/v1", model: "qwen3-tts-flash", voice: "Cherry" };

describe("speech text", () => {
  it("accepts a short line and rejects empty or long text", () => {
    assert.equal(speechText("  干得好\n，继续  "), "干得好 ，继续");
    assert.throws(() => speechText(""), /朗读文字/);
    assert.throws(() => speechText("好"), /朗读文字/);
    assert.throws(() => speechText("好".repeat(81)), /朗读文字/);
    assert.throws(() => speechText(undefined), /朗读文字/);
    assert.throws(() => speechText({ a: 1 }), /朗读文字/);
  });
});

describe("Qwen-TTS adapter", () => {
  it("posts the documented request, then downloads the clip without sending the API key to the clip host", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return json({ output: { audio: { url: "http://dashscope-result.oss-cn-beijing.aliyuncs.com/a.wav?sig=1" } } });
      return new Response(wavBytes(), { status: 200 });
    }) as typeof fetch;
    const out = await synthesize({ ...base, fetchImpl });
    assert.equal(out.type, "audio/wav");
    assert.equal(calls[0].url, "https://dashscope.example/api/v1/services/aigc/multimodal-generation/generation");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { model: "qwen3-tts-flash", input: { text: "干得好", voice: "Cherry", language_type: "Chinese" } });
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer secret-key");
    assert.match(calls[1].url, /^https:\/\/dashscope-result\.oss-cn-beijing\.aliyuncs\.com\//);
    assert.equal(JSON.stringify(calls[1].init ?? {}).includes("secret-key"), false);
  });
  it("also accepts inline base64 audio", async () => {
    const out = await synthesize({ ...base, fetchImpl: (async () => json({ output: { audio: { data: wavBytes().toString("base64") } } })) as typeof fetch });
    assert.equal(out.audio.length, 64);
  });
  it("refuses clip links that are not public https hosts", async () => {
    for (const url of ["http://169.254.169.254/a.wav", "https://127.0.0.1/a.wav", "https://localhost/a.wav", "http://example.com/a.wav", "file:///etc/passwd", "https://user:pw@example.com/a.wav"]) {
      await assert.rejects(synthesize({ ...base, fetchImpl: (async () => json({ output: { audio: { url } } })) as typeof fetch }), /语音合成服务/, url);
    }
  });
  it("fails closed on provider errors, missing audio and non-audio bytes", async () => {
    await assert.rejects(synthesize({ ...base, fetchImpl: (async () => json({}, 500)) as typeof fetch }), /语音合成服务/);
    await assert.rejects(synthesize({ ...base, fetchImpl: (async () => json({ output: {} })) as typeof fetch }), /语音合成服务/);
    await assert.rejects(synthesize({ ...base, fetchImpl: (async () => json({ output: { audio: { data: Buffer.from("<html>").toString("base64") } } })) as typeof fetch }), /语音合成服务/);
  });
});

describe("POST /api/voice/speech", () => {
  it("synthesizes once per line, records usage, replays from cache and enforces the text limit", async () => {
    const settings = { asrKey: env.asrKey, ttsModel: env.ttsModel };
    Object.assign(env, { asrKey: "test" });
    let inserts = 0, upstream = 0, consent = true;
    const db = createFakeDb((sql, _p: SqlParam[]) => {
      if (/FROM user_profile/.test(sql)) return { rows: [{ onboarded_at: "yes", cloud_consent: consent }], rowCount: 1 };
      if (/FROM usage_calls/.test(sql)) return { rows: [{ li: 0 }], rowCount: 1 };
      if (/INSERT INTO usage_calls/.test(sql)) inserts++;
      return { rows: [], rowCount: 0 };
    });
    const service = createVoiceService({ db }, undefined, async () => { upstream++; return { audio: wavBytes(), type: "audio/wav" }; });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as AuthedRequest).user = { id: "u1", email: "t@example.com", username: "t", role: "user", token_version: 0, email_verified_at: "yes" } as AuthedRequest["user"]; next(); });
    app.use("/api/voice", service.router);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => sendError(res, error));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/speech`;
    const post = (text: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    try {
      const first = await post("这一步干得漂亮");
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("content-type"), "audio/wav");
      assert.equal((await first.arrayBuffer()).byteLength, 64);
      assert.equal((await post("这一步干得漂亮")).status, 200);
      assert.equal(upstream, 1);
      assert.equal(inserts, 1);
      assert.equal((await post("另一句鼓励的话")).status, 200);
      assert.equal(upstream, 2);
      assert.equal((await post("好")).status, 400);
      assert.equal((await post("字".repeat(81))).status, 400);
      assert.equal(upstream, 2);
      consent = false;
      assert.equal((await post("这一步干得漂亮")).status, 403);
      consent = true;
      Object.assign(env, { asrKey: "" });
      assert.equal((await post("没配置时")).status, 503);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); Object.assign(env, settings); }
  });
});

describe("browser: cloud voice first, browser voice as fallback", () => {
  const src = (f: string) => readFileSync(new URL("../../web/" + f, import.meta.url), "utf8");
  function load(fetchImpl: (url: string, init?: unknown) => Promise<unknown>) {
    const log = { audio: [] as string[], browser: [] as string[], fetched: [] as string[] };
    const ctx: Record<string, unknown> = {
      window: { btUrl: (p: string) => "/task/" + p, speechSynthesis: { cancel() {}, getVoices: () => [], speak: (u: { text: string }) => log.browser.push(u.text) } },
      document: { readyState: "complete", addEventListener() {}, querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {} },
      SpeechSynthesisUtterance: function (this: Record<string, unknown>, t: string) { this.text = t; },
      Audio: function (this: Record<string, unknown>, s: string) { this.src = s; this.pause = () => {}; this.play = async () => { log.audio.push(s); }; },
      URL: { createObjectURL: () => "blob:clip", revokeObjectURL() {} },
      AbortSignal: { timeout: () => undefined },
      fetch: (u: string, i?: unknown) => { log.fetched.push(u); return fetchImpl(u, i); },
    };
    vm.createContext(ctx);
    vm.runInContext(src("js/praise-corpus.js"), ctx);
    vm.runInContext(src("js/praise.js"), ctx);
    return { praise: (ctx.window as { Task: { praise: { speak: (t: string) => Promise<string> } } }).Task.praise, log };
  }
  const ok = async () => ({ ok: true, status: 200, blob: async () => ({ size: 10 }) });

  it("plays the cloud clip and caches it so a repeat does not hit the server again", async () => {
    const a = load(ok);
    assert.equal(await a.praise.speak("干得好"), "cloud");
    assert.equal(await a.praise.speak("干得好"), "cloud");
    assert.equal(a.log.fetched.length, 1);
    assert.equal(a.log.fetched[0], "/task/api/voice/speech");
    assert.equal(a.log.audio.length, 2);
    assert.equal(a.log.browser.length, 0);
  });
  it("falls back to the browser voice when the server fails", async () => {
    const a = load(async () => ({ ok: false, status: 502, blob: async () => ({ size: 0 }) }));
    assert.equal(await a.praise.speak("干得好"), "browser");
    assert.equal(a.log.browser.length, 1);
  });
  it("stops asking the server for the rest of the session once it says it is unavailable", async () => {
    const a = load(async () => ({ ok: false, status: 503, blob: async () => ({ size: 0 }) }));
    assert.equal(await a.praise.speak("第一句话"), "browser");
    assert.equal(await a.praise.speak("第二句话"), "browser");
    assert.equal(a.log.fetched.length, 1);
  });
  it("falls back when the network request throws", async () => {
    const a = load(async () => { throw new Error("offline"); });
    assert.equal(await a.praise.speak("干得好"), "browser");
  });
});
