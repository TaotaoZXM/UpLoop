import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "./errors.js";
import { todayShanghai } from "./wellness/logic/time.js";

/** Express 4 does not await promise rejections; wrap every async handler. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function sendError(res: Response, error: unknown) {
  if (error instanceof HttpError) {
    return res.status((error as HttpError).status).json({ error: (error as HttpError).code, message: error.message });
  }
  console.error(error);
  if (!res.headersSent) res.status(500).json({ error: "server", message: "服务器出错了" });
  return undefined;
}

/** Single-process in-memory token bucket. WP2.5: documented as unsuitable for multi-process. */
const rateBuckets = new Map<string, number[]>();

export function allowRequest(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    rateBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return true;
}

export function resetRateBuckets() {
  rateBuckets.clear();
}

export function readCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index === -1) return;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!name) return;
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    });
  return cookies;
}

export function bearer(header: string | undefined) {
  const raw = String(header || "");
  return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : "";
}

export function isYmd(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isYm(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}

export function dayOf(input: unknown, at: Date = new Date()) {
  return isYmd(input) ? input : todayShanghai(at);
}

export function monthOf(input: unknown, at: Date = new Date()): string {
  return isYm(input) ? input : todayShanghai(at).slice(0, 7);
}

export function finiteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clampText(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}
