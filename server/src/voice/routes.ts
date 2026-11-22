import express, { Router, type RequestHandler } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authUser } from "../auth/session.js";
import { asyncRoute, allowRequest } from "../http.js";
import { requireConsent } from "../profile/routes.js";
import { env, LI_PER_YUAN, LIMIT_YUAN } from "../env.js";
import { HttpError } from "../errors.js";
import { assertCanCall } from "../usage/quota.js";
import { monthShanghai, todayShanghai } from "../wellness/logic/time.js";
import type { AppDeps } from "../types.js";
import { MAX_AUDIO_BYTES, transcribe, wavDuration } from "./asr.js";
import { speechText, synthesize, type Speech } from "./tts.js";
import { recordConfirmed } from "./records.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Job = { userId: string; hash: string; token: string; audio?: Buffer; expires: number; state: "pending" | "done" | "error"; text?: string; message?: string; controller: AbortController };

export function createVoiceService({ db }: AppDeps, recognize: typeof transcribe = transcribe, speak: typeof synthesize = synthesize) {
  const jobs = new Map<string, Job>();
  // Encouragement lines repeat, so a clip is generated once and replayed; oldest entries drop first.
  const clips = new Map<string, Speech>();
  const CLIP_LIMIT = 300;
  const prune = () => { for (const [key, job] of jobs) if (job.expires < Date.now()) { job.controller.abort(); jobs.delete(key); } };
  // Reclaim audio even when no further HTTP requests arrive.
  const timer = setInterval(prune, 30000); timer.unref();
  const ready = () => Boolean(env.asrKey && env.deepseekKey && /^https:\/\//.test(env.appPublicUrl));
  const limited: RequestHandler = (req, res, next) => {
    if (!allowRequest(`voice:${authUser(req).id}`, 10, 60000)) return res.status(429).json({ error: "rate_limited", message: "语音请求过于频繁，请稍后再试" });
    next();
  };
  const router = Router();
  const publicRouter = Router();
  publicRouter.get("/voice/audio/:token", (req, res) => {
    prune();
    const job = [...jobs.values()].find(item => item.token === req.params.token && item.audio);
    if (!job) return res.status(404).end();
    res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    return res.send(job.audio);
  });
  router.use(requireConsent(db));
  router.get("/config", (_req, res) => res.json({ enabled: ready(), maxSeconds: 60, languages: ["普通话", "English", "粤语"] }));
  router.post("/transcriptions/:id", limited, express.raw({ type: "audio/wav", limit: MAX_AUDIO_BYTES }), asyncRoute(async (req, res) => {
    if (!ready()) throw new HttpError(503, "voice_unconfigured", "语音服务尚未配置完成，请联系管理员");
    if (!UUID.test(String(req.params.id))) throw new HttpError(400, "request_id", "请求标识无效");
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "audio_format", "请上传 WAV 录音");
    const seconds = wavDuration(req.body);
    prune();
    const userId = authUser(req).id;
    const key = `${userId}:${req.params.id}`;
    const hash = createHash("sha256").update(req.body).digest("hex");
    const previous = jobs.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new HttpError(409, "voice_request_conflict", "录音内容已改变，请重新录音");
      return res.status(202).json({ state: previous.state });
    }
    if (jobs.size >= 100 || [...jobs.values()].filter(job => job.userId === userId && job.state === "pending").length >= 2) {
      throw new HttpError(429, "voice_busy", "语音服务正在处理其他录音，请稍后再试");
    }
    const job: Job = { userId, hash, token: randomBytes(32).toString("hex"), audio: req.body, expires: Date.now() + 10 * 60000, state: "pending", controller: new AbortController() };
    // Claim before the first await so concurrent retries cannot schedule twice.
    jobs.set(key, job);
    const usageId = randomUUID();
    const reservedCost = Math.max(1, Math.ceil(seconds * env.asrYuanPerSecond * LI_PER_YUAN));
    try {
      await assertCanCall(db, userId);
      await db.tx(async tx => {
        await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        const total = await tx.query<{ li: number }>("SELECT COALESCE(SUM(cost_li),0) AS li FROM usage_calls WHERE user_id=$1 AND month=$2", [userId, monthShanghai()]);
        if (Number(total.rows[0]?.li || 0) + reservedCost > LIMIT_YUAN * LI_PER_YUAN) throw new HttpError(403, "quota", "本月额度已用完，对话已暂停");
        // Keep full-duration cost on provider failure/timeout because a job may
        // still have been billed. Reconcile actual duration on success.
        await tx.query(`INSERT INTO usage_calls (id,user_id,created_at,month,day,kind,model,prompt_tokens,completion_tokens,cached_tokens,miss_tokens,peak,cost_li,status)
          VALUES ($1,$2,now(),$3,$4,'voice_asr',$5,0,0,0,0,false,$6,'pending')`,
          [usageId, userId, monthShanghai(), todayShanghai(), env.asrModel, reservedCost]);
      });
    } catch (error) { jobs.delete(key); throw error; }
    const timeout = setTimeout(() => job.controller.abort(), 150000); timeout.unref();
    void recognize({ audioUrl: `${env.appPublicUrl.replace(/\/$/, "")}${env.basePath}/voice/audio/${job.token}`, key: env.asrKey, base: env.asrBase, model: env.asrModel, signal: job.controller.signal })
      .then(async result => {
        job.text = result.text;
        const duration = Number.isFinite(result.billedSeconds) && Number(result.billedSeconds) >= 0 ? Number(result.billedSeconds) : seconds;
        await db.query("UPDATE usage_calls SET cost_li=$1,status='ok' WHERE id=$2", [Math.max(1, Math.ceil(duration * env.asrYuanPerSecond * LI_PER_YUAN)), usageId]);
        job.state = "done";
      }).catch(async () => {
        job.state = "error"; job.message = "语音识别未完成，请检查网络和录音后重试";
        await db.query("UPDATE usage_calls SET status='error' WHERE id=$1", [usageId]).catch(() => {});
      }).finally(() => { clearTimeout(timeout); job.audio = undefined; });
    return res.status(202).json({ state: "pending" });
  }));
  router.get("/transcriptions/:id", (req, res) => {
    prune();
    const job = jobs.get(`${authUser(req).id}:${req.params.id}`);
    if (!job) return res.status(404).json({ error: "voice_expired", message: "录音任务已过期，请重新录音" });
    return res.json({ state: job.state, text: job.text, message: job.message });
  });
  router.delete("/transcriptions/:id", (req, res) => {
    const key = `${authUser(req).id}:${req.params.id}`;
    const job = jobs.get(key);
    job?.controller.abort(); jobs.delete(key);
    return res.status(204).end();
  });
  router.post("/speech", (req, res, next) => {
    if (!allowRequest(`tts:${authUser(req).id}`, 30, 60000)) return res.status(429).json({ error: "rate_limited", message: "朗读请求过于频繁，请稍后再试" });
    next();
  }, asyncRoute(async (req, res) => {
    if (!env.asrKey) throw new HttpError(503, "tts_unconfigured", "语音合成尚未配置");
    const text = speechText(req.body?.text);
    const userId = authUser(req).id;
    const key = createHash("sha256").update(`${env.ttsModel}\n${env.ttsVoice}\n${text}`).digest("hex");
    let clip = clips.get(key);
    if (!clip) {
      await assertCanCall(db, userId);
      clip = await speak({ text, key: env.asrKey, base: env.asrBase, model: env.ttsModel, voice: env.ttsVoice });
      const cost = Math.max(1, Math.ceil(Array.from(text).length * env.ttsYuanPerChar * LI_PER_YUAN));
      await db.query(`INSERT INTO usage_calls (id,user_id,created_at,month,day,kind,model,prompt_tokens,completion_tokens,cached_tokens,miss_tokens,peak,cost_li,status)
        VALUES ($1,$2,now(),$3,$4,'voice_tts',$5,0,0,0,0,false,$6,'ok')`, [randomUUID(), userId, monthShanghai(), todayShanghai(), env.ttsModel, cost]);
      clips.set(key, clip);
      if (clips.size > CLIP_LIMIT) clips.delete(clips.keys().next().value as string);
    }
    res.set({ "Content-Type": clip.type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
    return res.send(clip.audio);
  }));
  router.post("/records", limited, asyncRoute(async (req, res) => {
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    const requestId = String(req.body.requestId || "");
    if (!UUID.test(requestId) || !text || text.length > 2000) throw new HttpError(400, "voice_input", "请确认识别文字后再发送（最多2000字）");
    const result = await recordConfirmed(db, authUser(req).id, requestId, text);
    return res.json(result);
  }));
  return { router, publicRouter };
}
