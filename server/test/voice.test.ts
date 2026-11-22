import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import express from "express";
import { createFakeDb, type SqlParam } from "../src/db/pool.js";
import { transcribe, wavDuration } from "../src/voice/asr.js";
import { validateInterpretation, recordConfirmed, interpret } from "../src/voice/records.js";
import { createVoiceService } from "../src/voice/routes.js";
import { sendError } from "../src/http.js";
import { env } from "../src/env.js";
import type { AuthedRequest } from "../src/types.js";

function wav(seconds = 1) {
  const b = Buffer.alloc(44 + seconds * 32000);
  b.write("RIFF", 0); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("voice audio and Fun-ASR adapter", () => {
  it("validates actual WAV format and duration, not supplied metadata", () => {
    assert.equal(wavDuration(wav()), 1);
    assert.equal(wavDuration(wav(60)), 60);
    assert.throws(() => wavDuration(wav(61)), /60 秒/);
    assert.throws(() => wavDuration(Buffer.from("not audio")), /PCM WAV/);
    const stereo = wav(); stereo.writeUInt16LE(2, 22);
    assert.throws(() => wavDuration(stereo), /单声道/);
  });
  it("submits the documented async API, polls, parses mixed-language text without leaking credentials", async () => {
    const calls: Array<{ url: string; options?: RequestInit }> = [];
    const fetchImpl = async (url: unknown, options?: RequestInit) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return response({ output: { task_id: "job", task_status: "PENDING" } });
      if (calls.length === 2) return response({ output: { task_status: "RUNNING" } });
      if (calls.length === 3) return response({ output: { task_status: "SUCCEEDED", results: [{ subtask_status: "SUCCEEDED", transcription_url: "https://result.example/transcript" }] }, usage: { duration: 2.5 } });
      return response({ transcripts: [{ text: "我飲咗三百毫升水。" }, { text: "Lunch cost thirty two yuan." }] });
    };
    const result = await transcribe({ audioUrl: "https://task.example/task/voice/audio/token", key: "test-key", base: "https://dashscope.example/api/v1", model: "fun-asr", fetchImpl: fetchImpl as typeof fetch, pause: async () => {} });
    assert.equal(result.billedSeconds, 2.5);
    assert.match(result.text, /我飲咗.*Lunch/);
    const sent = JSON.parse(calls[0].options!.body as string);
    assert.equal(sent.model, "fun-asr");
    assert.deepEqual(sent.parameters.channel_id, [0]);
    assert.equal((calls[0].options!.headers as Record<string, string>)["X-DashScope-Async"], "enable");
    assert.equal(calls[3].options!.headers, undefined);
  });
  it("does not mistake overall SUCCEEDED for a successful audio subtask", async () => {
    let n = 0;
    await assert.rejects(transcribe({ audioUrl: "https://example/audio", key: "key", base: "https://example/api", model: "fun-asr", pause: async () => {}, fetchImpl: (async () => response(++n === 1 ? { output: { task_id: "job" } } : { output: { task_status: "SUCCEEDED", results: [{ subtask_status: "FAILED" }] } })) as typeof fetch }), /失败/);
  });
  it("handles empty speech as a recoverable error", async () => {
    let n = 0;
    await assert.rejects(transcribe({ audioUrl: "https://example/audio", key: "key", base: "https://example/api", model: "fun-asr", pause: async () => {}, fetchImpl: (async () => response(++n === 1 ? { output: { task_id: "job" } } : n === 2 ? { output: { task_status: "SUCCEEDED", results: [{ subtask_status: "SUCCEEDED", transcription_url: "https://example/result" }] } } : { transcripts: [] })) as typeof fetch }), /没有识别到/);
  });
});

describe("voice record understanding and duplicate prevention", () => {
  it("routes English/Cantonese through the model tool without trusting prose-only output", async () => {
    const originalFetch = globalThis.fetch;
    const key = env.deepseekKey;
    Object.assign(env, { deepseekKey: "mock-key" });
    const db = createFakeDb(() => ({ rows: [{ li: 0 }], rowCount: 1 }));
    const prepared = { commands: [{ text: "喝了300毫升水", action: "record", day: "2026-11-05" }, { text: "花了32.5元 午饭", action: "record", day: "2026-11-05" }], clarification: "" };
    const requests: Record<string, unknown>[] = [];
    let count = 0;
    globalThis.fetch = (async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)));
      return response(++count % 2 ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "plan", function: { name: "prepare_records", arguments: JSON.stringify(prepared) } }] } }] } : { choices: [{ message: { role: "assistant", content: "" } }] });
    }) as typeof fetch;
    try {
      for (const text of ["I drank three hundred milliliters of water. Lunch cost thirty two yuan fifty.", "我飲咗三百毫升水，午餐用咗三十二蚊五。", "喝了三百毫升水，午饭花了三十二块五"]) {
        assert.deepEqual(await interpret(db, "user", text), prepared);
      }
      assert.equal(requests.length, 6);
      const prompt = JSON.stringify(requests[0].messages);
      assert.match(prompt, /粤语/); assert.match(prompt, /English/); assert.match(prompt, /缺失/);
    } finally { globalThis.fetch = originalFetch; Object.assign(env, { deepseekKey: key }); }
  });
  it("rejects invalid plans and asks for missing information before executing any command", () => {
    assert.throws(() => validateInterpretation({ commands: [{ text: "喝水300ml", day: "2026-02-30", action: "record" }] }), /明确/);
    const result = validateInterpretation({ commands: [{ text: "喝水300ml", day: "2026-11-05", action: "record" }], clarification: "午饭花了多少元？" });
    assert.deepEqual(result.commands, []);
    assert.equal(result.clarification, "午饭花了多少元？");
  });
  it("writes a normalized income once and rejects reuse of its request ID with changed text", async () => {
    let receipt: Record<string, unknown> | undefined;
    let writes = 0;
    const db = createFakeDb((sql, params) => {
      let rows: Record<string, unknown>[] = [];
      if (/SELECT input_hash/.test(sql)) rows = receipt ? [receipt] : [];
      else if (/INSERT INTO voice_requests/.test(sql)) { receipt = { input_hash: params[2], result: null }; rows = [{ request_id: params[1] }]; }
      else if (/UPDATE voice_requests/.test(sql)) receipt!.result = JSON.parse(String(params[0]));
      else if (/FROM user_profile/.test(sql)) rows = [{ cloud_consent: true, onboarded_at: "2026-11-01" }];
      else if (/FROM usage_calls/.test(sql)) rows = [{ li: 0 }];
      else if (/INSERT INTO expenses/.test(sql)) { writes++; rows = [{ id: params[0], amount_cents: params[2], kind: params[3], day: params[7] }]; }
      return { rows, rowCount: rows.length };
    });
    const prepare = async () => ({ commands: [{ text: "工资到账8000元", day: "2026-11-05", action: "record" as const }], clarification: "" });
    const id = randomUUID();
    const first = await recordConfirmed(db, "user", id, "Salary eight thousand yuan", prepare);
    assert.match(first.reply, /收入 8000.00/);
    assert.deepEqual(await recordConfirmed(db, "user", id, "Salary eight thousand yuan", prepare), first);
    assert.equal(writes, 1);
    await assert.rejects(recordConfirmed(db, "user", id, "different text", prepare), /内容已改变/);
  });
  it("stores the original spoken utterance and one combined reply, not internal translations", async () => {
    const messages: SqlParam[][] = [];
    const db = createFakeDb((sql, params) => {
      let rows: Record<string, unknown>[] = [];
      if (/INSERT INTO voice_requests/.test(sql)) rows = [{ request_id: params[1] }];
      if (/FROM user_profile/.test(sql)) rows = [{ cloud_consent: true, onboarded_at: "yes" }];
      if (/FROM usage_calls/.test(sql)) rows = [{ li: 0 }];
      if (/INSERT INTO expenses/.test(sql)) rows = [{ id: params[0], amount_cents: params[2], kind: params[3] }];
      if (/INSERT INTO chat_messages/.test(sql)) messages.push(params);
      return { rows, rowCount: rows.length };
    });
    const original = "Lunch cost thirty-two yuan, salary arrived eight thousand.";
    const result = await recordConfirmed(db, "user", randomUUID(), original, async () => ({
      commands: [ { text: "花了32元 午饭", day: "2026-11-05", action: "record" },
        { text: "工资到账8000元", day: "2026-11-05", action: "record" } ], clarification: "",
    }));
    assert.equal(messages.length, 2);
    assert.equal(messages[0][2], "user"); assert.equal(messages[0][3], original);
    assert.equal(JSON.parse(String(messages[0][5])).source, "voice");
    assert.equal(messages[1][2], "assistant"); assert.equal(messages[1][3], result.reply);
    assert.equal(JSON.parse(String(messages[1][5])).cards.length, 2);
  });
  it("task completion uses exact matching and never silently creates a missing Done", async () => {
    let state = { version: 1, todo: [{ id: "task-1", title: "回电话" }], done: [] as unknown[] };
    const db = createFakeDb((sql, params) => {
      let rows: Record<string, unknown>[] = [];
      if (/INSERT INTO voice_requests/.test(sql)) rows = [{ request_id: params[1] }];
      if (/SELECT state/.test(sql)) rows = [{ state }];
      if (/INSERT INTO user_app_state/.test(sql)) state = JSON.parse(String(params[1]));
      return { rows, rowCount: rows.length };
    });
    const prepare = async () => ({ commands: [{ text: "完成回电话", title: "回电话", day: "2026-11-05", action: "complete_task" as const }], clarification: "" });
    await recordConfirmed(db, "user", randomUUID(), "I finished the call", prepare);
    assert.equal(state.todo.length, 0); assert.equal(state.done.length, 1);
    const again = await recordConfirmed(db, "user", randomUUID(), "I finished the call", prepare);
    assert.equal(again.intent, "clarify"); assert.equal(state.done.length, 1);
  });
});

describe("voice HTTP boundaries", () => {
  it("keeps audio transient, idempotent, scoped to account, and gated by cloud consent", async () => {
    const settings = { asrKey: env.asrKey, deepseekKey: env.deepseekKey, appPublicUrl: env.appPublicUrl };
    Object.assign(env, { asrKey: "test", deepseekKey: "test", appPublicUrl: "https://task.example" });
    let consent = true;
    let reserved = 0;
    let finish: (value: { text: string; billedSeconds: number }) => void = () => {};
    let providerUrl = "";
    const db = createFakeDb((sql, _params: SqlParam[]) => {
      if (/FROM user_profile/.test(sql)) return { rows: [{ onboarded_at: "yes", cloud_consent: consent }], rowCount: 1 };
      if (/FROM usage_calls/.test(sql)) return { rows: [{ li: 0 }], rowCount: 1 };
      if (/INSERT INTO usage_calls/.test(sql)) reserved++;
      return { rows: [], rowCount: 0 };
    });
    const service = createVoiceService({ db }, async input => { providerUrl = input.audioUrl; return new Promise(resolve => { finish = resolve; }); });
    const app = express(); app.use(express.json()); app.use(service.publicRouter);
    app.use((req, _res, next) => { (req as AuthedRequest).user = { id: req.get("x-user") || "user", email: "test@example.com", username: "test", role: "user", token_version: 0, email_verified_at: "yes" }; next(); });
    app.use("/api/voice", service.router);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => sendError(res, error));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const id = randomUUID();
    try {
      const post = () => fetch(`${base}/api/voice/transcriptions/${id}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav() });
      assert.equal((await post()).status, 202);
      assert.equal((await post()).status, 202);
      assert.equal(reserved, 1);
      const audioPath = new URL(providerUrl).pathname;
      assert.equal((await fetch(base + audioPath)).status, 200);
      assert.equal((await fetch(`${base}/api/voice/transcriptions/${id}`, { headers: { "x-user": "another" } })).status, 404);
      finish({ text: "我飲咗三百毫升水", billedSeconds: 1 });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await fetch(base + audioPath)).status, 404);
      assert.equal((await (await fetch(`${base}/api/voice/transcriptions/${id}`)).json()).text, "我飲咗三百毫升水");
      consent = false;
      assert.equal((await fetch(`${base}/api/voice/config`)).status, 403);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); Object.assign(env, settings); }
  });
});
