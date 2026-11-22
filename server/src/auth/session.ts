import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import type { Db } from "../db/pool.js";
import { env } from "../env.js";
import { HttpError } from "../errors.js";
import { bearer, readCookies } from "../http.js";
import type { AuthUser, AuthedRequest } from "../types.js";

/**
 * Cookie name and Path are app-specific (`task_session`, Path = BASE_PATH or
 * "/"). This avoids colliding with another app's session on the same host.
 * Do not rename SESSION_COOKIE or change this Path rule without a migration.
 */
export const SESSION_COOKIE = "task_session";
export const SESSION_TTL = "7d";
export const DEVICE_PREFIX = "taskr_";

/** Scoped to the app's mount prefix: /task in production, / for local dev. */
function sessionCookiePath() {
  return env.basePath || "/";
}

const USER_COLUMNS = "id, email, username, email_verified_at, token_version, role";

export function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function expiresToSeconds(value: string) {
  const match = /^(\d+)([smhd])?$/.exec(value || "30d");
  if (!match) return 30 * 24 * 60 * 60;
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] || "s"]!;
}

export function readToken(req: Request) {
  const fromHeader = bearer(req.get("authorization"));
  if (fromHeader) return fromHeader;
  return readCookies(req.headers.cookie)[SESSION_COOKIE] || "";
}

/** WP2.5: sha256(secret + token). Plaintext is returned to the user exactly once. */
export function hashDeviceToken(token: string) {
  return createHash("sha256").update(`${env.deviceTokenSecret}${token}`).digest("hex");
}

function cookieSecure(req: Request) {
  if (process.env.COOKIE_SECURE === "1") return true;
  if (process.env.COOKIE_SECURE === "0") return false;
  return Boolean(req.secure);
}

export function writeSessionCookie(req: Request, res: Response, token: string) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    `Path=${sessionCookiePath()}`,
    "SameSite=Lax",
    `Max-Age=${expiresToSeconds(SESSION_TTL)}`,
  ];
  if (cookieSecure(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(req: Request, res: Response) {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", `Path=${sessionCookiePath()}`, "SameSite=Lax", "Max-Age=0"];
  if (cookieSecure(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function publicUser(row: AuthUser | Record<string, unknown>) {
  const user = row as AuthUser;
  return {
    id: user.id,
    email: user.email,
    username: user.username || null,
    emailVerified: Boolean(user.email_verified_at),
    role: user.role || "user",
  };
}

export function signToken(user: Pick<AuthUser, "id" | "email" | "token_version">) {
  return jwt.sign(
    { sub: user.id, email: user.email, tv: Number(user.token_version || 0) },
    env.jwtSecret,
    { expiresIn: SESSION_TTL },
  );
}

/**
 * WP2.5: a Bearer value starting with `taskr_` is a long-lived device token.
 * It is independent of token_version and is revoked on its own.
 */
export async function userFromRequest(db: Db, req: Request): Promise<{ user: AuthUser; viaDevice: boolean } | null> {
  const token = readToken(req);
  if (!token) return null;

  if (token.startsWith(DEVICE_PREFIX)) {
    const device = await db.one<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM device_tokens WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1",
      [hashDeviceToken(token)],
    );
    if (!device) return null;
    await db.query("UPDATE device_tokens SET last_used_at = now() WHERE id = $1", [device.id]);
    const user = await db.one<AuthUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`, [device.user_id]);
    return user ? { user, viaDevice: true } : null;
  }

  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded === "string") return null;
    payload = decoded;
  } catch {
    return null;
  }
  const userId = String(payload.sub || "");
  if (!userId) return null;
  const user = await db.one<AuthUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`, [userId]);
  if (!user) return null;
  if (Number(payload.tv || 0) !== Number(user.token_version || 0)) return null;
  return { user, viaDevice: false };
}

export function requireUser(db: Db): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void userFromRequest(db, req)
      .then((found) => {
        if (!found) {
          res.status(401).json({ error: "unauthorized", message: "请先登录" });
          return;
        }
        (req as AuthedRequest).user = found.user;
        (req as AuthedRequest).viaDevice = found.viaDevice;
        next();
      })
      .catch(next);
  };
}

export function authUser(req: Request): AuthUser {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, "unauthorized", "请先登录");
  return user;
}

export function isDeviceRequest(req: Request) {
  return Boolean((req as AuthedRequest).viaDevice);
}

export function requireAdmin(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (authUser(req).role !== "admin") {
      res.status(403).json({ error: "forbidden", message: "需要管理员权限" });
      return;
    }
    next();
  };
}
