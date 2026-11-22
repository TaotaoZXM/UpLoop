/** WP2.1/WP2.5: /api/chat and /v1/chat share ONE handler and ONE usage account. */
import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { asyncRoute, allowRequest, dayOf } from "../http.js";
import { authUser } from "../auth/session.js";
import { env } from "../env.js";
import { daySummary } from "../wellness/repo.js";
import type { AppDeps, AuthedRequest } from "../types.js";
import { recordConfirmed } from "../voice/records.js";
import { detectIntents } from "./intent.js";
import { wellnessGate } from "../wellness/chat.js";
import { loadProfile } from "../profile/routes.js";
import { HttpError, onboardingRequired, consentRequired } from "../errors.js";
import { handleChat } from "./router.js";

/** Q8: 20 chat requests per minute per account+IP. In-process only (§14). */
export function chatRateLimit(): RequestHandler {
  return (req: Request, res: Response, next) => {
    const userId = (req as AuthedRequest).user?.id || "anonymous";
    const key = `chat:${userId}:${req.ip}`;
    if (!allowRequest(key, env.chatRatePerMinute, 60_000)) {
      res.status(429).json({ error: "rate_limited", message: "请求过于频繁，请稍后再试" });
      return;
    }
    next();
  };
}

export function postChatHandler(deps: AppDeps, source: "web" | "device" = "web") {
  return asyncRoute(async (req, res) => {
    const user = authUser(req);
    const body = (req.body || {}) as { text?: string; message?: string; day?: string; source?: string; requestId?: string };
    const text = String(body.text || body.message || "");
    const mode = source === "device" ? "device" : body.source === "voice" ? "voice" : source;
    const recordIntent = !detectIntents(text).some(intent => ["retired", "focus", "report", "routine"].includes(intent));
    // Preserve existing companion actions; record utterances from either input
    // use the same multilingual parser when configured.
    if (!wellnessGate(text) && (recordIntent && (mode === "voice" || env.deepseekKey))) {
      if (!text.trim() || text.length > 2000) throw new HttpError(400, "chat_input", "请填写2000字以内的内容");
      const profile = await loadProfile(deps.db, user.id);
      if (!profile?.onboarded_at) throw onboardingRequired();
      if (!profile.cloud_consent) throw consentRequired();
      // Preserve a pending structured follow-up and explicitly dated clients.
      if ((env.wellnessEnabled && profile.pending) || body.day) return res.json(await handleChat(deps, { userId: user.id, text, day: dayOf(body.day), source: mode }));
      const requestId = body.requestId || randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new HttpError(400, "request_id", "请求标识无效");
      return res.json(await recordConfirmed(deps.db, user.id, requestId, text, undefined, mode));
    }
    const result = await handleChat(deps, {
      userId: user.id,
      text,
      day: dayOf(body.day),
      source: mode,
    });
    return res.json(result);
  });
}

export function v1SummaryHandler(deps: AppDeps) {
  return asyncRoute(async (req, res) => {
    if (!env.wellnessEnabled) return res.status(403).json({ error: "feature_disabled", feature: "wellness", message: "Wellness 已暂停使用，已有数据保留。" });
    const user = authUser(req);
    const day = dayOf(req.query.day);
    const summary = await daySummary(deps.db, user.id, day);
    return res.json({ day, summary: summary.summary, suggestion: summary.suggestion, entries: summary.entries });
  });
}
