/**
 * WP1.1/1.2: qingzhou's nine account endpoints, now TypeScript + PostgreSQL.
 * SQL dialect changes: ? -> $n, UTC_TIMESTAMP(3) -> now(), ER_DUP_ENTRY -> 23505,
 * CAST(? AS JSON) / JSON_EXTRACT removed in favour of $n::jsonb.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import type { Executor } from "../db/pool.js";
import { env } from "../env.js";
import { asyncRoute, allowRequest } from "../http.js";
import type { AppDeps } from "../types.js";
import {
  assertDirectMailEnv,
  DirectMailError,
  passwordResetMessage,
  redactMailLog,
  singleSendMail,
  verificationMessage,
} from "./mail.js";
import { resetPasswordPage, verifyErrorPage, verifySuccessPage } from "./pages.js";
import { appHomeUrl, resolvePublicOrigin } from "./public-origin.js";
import {
  clearSessionCookie,
  publicUser,
  signToken,
  userFromRequest,
  writeSessionCookie,
} from "./session.js";
import { adminUsernameFromEnv } from "./admin.js";

const BCRYPT_ROUNDS = 10;
const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

async function txOne<T>(tx: Executor, sql: string, params: unknown[] = []) {
  return (await tx.query<T>(sql, params as never[])).rows[0];
}

function normalizeEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function loginIdentifier(value: unknown) {
  const raw = String(value || "").trim();
  const adminUsername = adminUsernameFromEnv();
  if (adminUsername && raw === adminUsername) return raw;
  return normalizeEmail(raw);
}

function blockedRegistrationName(value: unknown) {
  const name = String(value || "").trim().toLowerCase();
  if (!name) return false;
  if (name === "admin") return true;
  const configured = adminUsernameFromEnv().toLowerCase();
  return Boolean(configured) && name === configured;
}

function needsEmailVerification(user: { email_verified_at: unknown; role: string }) {
  return !user.email_verified_at && user.role !== "admin";
}

function passwordError(password: string) {
  if (password.length < 8) return "密码至少 8 位";
  if (password.length > 128) return "密码不能超过 128 位";
  return "";
}

function normalizeUsername(value: unknown) {
  const username = String(value || "").trim().replace(/\s+/g, " ");
  if (!username || /[\u0000-\u001f]/.test(username)) return "";
  if ([...username].length > 20) return "";
  return username;
}

function mailConfigured() {
  return env.emailDelivery === "directmail";
}

function exposeDevLinks() {
  return env.exposeDevLinks && env.nodeEnv !== "production" && !mailConfigured();
}

function verificationRequired() {
  return mailConfigured() || exposeDevLinks();
}

let invalidPublicUrlWarned = false;

function publicOrigin(req: Request) {
  if (env.appPublicUrl) {
    const resolved = resolvePublicOrigin(env.appPublicUrl);
    if (resolved) return resolved;
    if (!invalidPublicUrlWarned) {
      invalidPublicUrlWarned = true;
      console.error("[email] APP_PUBLIC_URL is not an http(s) origin; using the request host");
    }
  }
  return `${req.protocol}://${req.get("host")}`;
}

function publicOriginFromLink(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function hashResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function logMailFailure(kind: string, email: string, error: unknown) {
  const e = error as DirectMailError;
  console.error(
    `[${kind}] send failed for ${email} code=${e?.code || "MailError"} requestId=${e?.requestId || ""} status=${e?.status || ""} ${redactMailLog(e?.message)}`,
  );
}

/** Exported so the account tests can stub/observe the delivery boundary. */
export async function sendPasswordResetEmail(input: { email: string; resetUrl: string }) {
  if (mailConfigured()) {
    const message = passwordResetMessage({ resetUrl: input.resetUrl, appUrl: appHomeUrl(publicOriginFromLink(input.resetUrl)) });
    const result = await singleSendMail({ toAddress: input.email, ...message });
    console.info(`[directmail] password reset sent to ${input.email} requestId=${result.requestId}`);
    return { delivered: true };
  }
  if (env.emailDelivery === "log") console.info(`[password-reset] ${input.email} ${input.resetUrl}`);
  else console.info(`[password-reset] delivery not configured for ${input.email}`);
  return { delivered: false };
}

export async function sendVerificationEmail(input: { email: string; verifyUrl: string }) {
  if (mailConfigured()) {
    const message = verificationMessage({ verifyUrl: input.verifyUrl, appUrl: appHomeUrl(publicOriginFromLink(input.verifyUrl)) });
    const result = await singleSendMail({ toAddress: input.email, ...message });
    console.info(`[directmail] verification sent to ${input.email} requestId=${result.requestId}`);
    return { delivered: true };
  }
  if (env.emailDelivery === "log") console.info(`[email-verify] ${input.email} ${input.verifyUrl}`);
  else console.info(`[email-verify] delivery not configured for ${input.email}`);
  return { delivered: false };
}

async function issueVerificationUrl(db: AppDeps["db"], userId: string, req: Request) {
  const existing = await db.one(
    "SELECT id FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1",
    [userId],
  );
  if (existing) return "";
  const rawToken = randomBytes(32).toString("hex");
  await db.query("DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL", [userId]);
  await db.query(
    "INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4::timestamptz)",
    [randomUUID(), userId, hashResetToken(rawToken), new Date(Date.now() + VERIFY_TTL_MS).toISOString()],
  );
  const verifyUrl = `${publicOrigin(req)}${env.baseUrlPath}api/auth/verify?token=${encodeURIComponent(rawToken)}`;
  const row = await db.one<{ email: string }>("SELECT email FROM users WHERE id = $1 LIMIT 1", [userId]);
  try {
    await sendVerificationEmail({ email: row?.email || "", verifyUrl });
  } catch (error) {
    await db.query("DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL", [userId]).catch(() => undefined);
    throw error;
  }
  return verifyUrl;
}

export function createAuthRouter({ db }: AppDeps) {
  const router = Router();

  router.post(
    "/auth/register",
    asyncRoute(async (req, res) => {
      if (!allowRequest(`register:${req.ip}`, 20, 15 * 60 * 1000)) {
        return res.status(429).json({ error: "rate_limited", message: "请求过于频繁，请稍后再试" });
      }
      const rawEmail = String(req.body?.email || "");
      if (blockedRegistrationName(rawEmail)) return res.status(400).json({ error: "invalid_email", message: "请填写有效的邮箱" });
      const email = normalizeEmail(rawEmail);
      const password = String(req.body?.password || "");
      if (!email) return res.status(400).json({ error: "invalid_email", message: "请填写有效的邮箱" });
      const invalidPassword = passwordError(password);
      if (invalidPassword) return res.status(400).json({ error: "invalid_password", message: invalidPassword });

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const verify = verificationRequired();
      const id = randomUUID();
      const rawToken = verify ? randomBytes(32).toString("hex") : "";
      try {
        await db.tx(async (tx) => {
          if (verify) {
            await tx.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [id, email, passwordHash]);
            await tx.query(
              "INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4::timestamptz)",
              [randomUUID(), id, hashResetToken(rawToken), new Date(Date.now() + VERIFY_TTL_MS).toISOString()],
            );
          } else {
            await tx.query(
              "INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, now())",
              [id, email, passwordHash],
            );
          }
        });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return res.status(409).json({ error: "duplicate_email", message: "该邮箱已注册" });
        throw error;
      }

      const user = { id, email, username: null, email_verified_at: verify ? null : new Date().toISOString(), token_version: 0, role: "user" };
      if (!verify) {
        return res.status(201).json({ user: publicUser(user), verificationRequired: false, message: "账号已创建，可以登录" });
      }
      const verifyUrl = `${publicOrigin(req)}${env.baseUrlPath}api/auth/verify?token=${encodeURIComponent(rawToken)}`;
      try {
        await sendVerificationEmail({ email, verifyUrl });
      } catch (error) {
        logMailFailure("email-verify", email, error);
        await db.query("DELETE FROM users WHERE id = $1 AND email_verified_at IS NULL", [id]).catch(() => undefined);
        return res.status(503).json({ error: "mail_failed", message: "验证邮件发送失败，请稍后再试" });
      }
      const body: Record<string, unknown> = {
        user: publicUser(user),
        verificationRequired: true,
        message: "账号已创建，请完成邮箱验证",
      };
      if (exposeDevLinks()) body.verifyUrl = verifyUrl;
      return res.status(201).json(body);
    }),
  );

  router.post(
    "/auth/login",
    asyncRoute(async (req, res) => {
      if (!allowRequest(`login:${req.ip}`, 30, 15 * 60 * 1000)) {
        return res.status(429).json({ error: "rate_limited", message: "请求过于频繁，请稍后再试" });
      }
      const email = loginIdentifier(req.body?.email);
      const password = String(req.body?.password || "");
      if (!email || !password) return res.status(400).json({ error: "missing_credentials", message: "请填写邮箱和密码" });
      const user = await db.one<{ id: string; email: string; username: string | null; email_verified_at: string | null; password_hash: string; token_version: number; role: string }>(
        "SELECT id, email, username, email_verified_at, password_hash, token_version, role FROM users WHERE email = $1 LIMIT 1",
        [email],
      );
      const matches = user ? await bcrypt.compare(password, user.password_hash) : false;
      if (!user || !matches) return res.status(401).json({ error: "invalid_credentials", message: "邮箱或密码不正确" });
      if (needsEmailVerification(user) && verificationRequired()) {
        try {
          const verifyUrl = await issueVerificationUrl(db, user.id, req);
          const body: Record<string, unknown> = { error: "email_unverified", message: "请先完成邮箱验证" };
          if (verifyUrl && exposeDevLinks()) body.verifyUrl = verifyUrl;
          return res.status(403).json(body);
        } catch (error) {
          logMailFailure("email-verify", user.email, error);
          return res.status(503).json({ error: "mail_failed", message: "验证邮件发送失败，请稍后再试" });
        }
      }
      if (needsEmailVerification(user)) {
        await db.query("UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL", [user.id]);
        user.email_verified_at = new Date().toISOString();
      }
      writeSessionCookie(req, res, signToken(user));
      return res.json({ user: publicUser(user) });
    }),
  );

  router.post("/auth/logout", (req: Request, res: Response) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  router.get("/auth/me", asyncRoute(async (req, res) => {
    const found = await userFromRequest(db, req);
    if (!found) return res.status(401).json({ error: "unauthorized", message: "请先登录" });
    return res.json({ user: publicUser(found.user) });
  }));

  router.post(
    "/auth/forgot-password",
    asyncRoute(async (req, res) => {
      if (!allowRequest(`reset:${req.ip}`, 8, 15 * 60 * 1000)) {
        return res.status(429).json({ error: "rate_limited", message: "请求过于频繁，请稍后再试" });
      }
      const email = normalizeEmail(req.body?.email);
      if (!email) return res.status(400).json({ error: "invalid_email", message: "请先填写邮箱" });
      const devLinks = exposeDevLinks();
      if (!mailConfigured() && !devLinks) {
        return res.status(503).json({ error: "reset_unavailable", message: "找回密码暂不可用，请联系管理员" });
      }
      const user = await db.one<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = $1 LIMIT 1", [email]);
      let resetUrl = "";
      if (user) {
        const rawToken = randomBytes(32).toString("hex");
        await db.query("DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL", [user.id]);
        await db.query(
          "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4::timestamptz)",
          [randomUUID(), user.id, hashResetToken(rawToken), new Date(Date.now() + RESET_TTL_MS).toISOString()],
        );
        resetUrl = `${publicOrigin(req)}${env.baseUrlPath}api/auth/reset?token=${encodeURIComponent(rawToken)}`;
        try {
          await sendPasswordResetEmail({ email: user.email, resetUrl });
        } catch (error) {
          logMailFailure("password-reset", user.email, error);
          await db.query("DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL", [user.id]).catch(() => undefined);
          return res.status(503).json({ error: "mail_failed", message: "邮件发送失败，请稍后再试" });
        }
      }
      const body: Record<string, unknown> = {
        ok: true,
        message: devLinks && !mailConfigured()
          ? "如果该邮箱已注册，可以使用重置链接。邮件发送尚未接入。"
          : "如果该邮箱已注册，重置邮件已发送。",
      };
      if (user && devLinks) body.resetUrl = resetUrl;
      return res.json(body);
    }),
  );

  router.post(
    "/auth/reset-password",
    asyncRoute(async (req, res) => {
      const token = String(req.body?.token || "").trim();
      const password = String(req.body?.password || "");
      const invalidPassword = passwordError(password);
      if (!token) return res.status(400).json({ error: "missing_token", message: "缺少重置信息" });
      if (invalidPassword) return res.status(400).json({ error: "invalid_password", message: invalidPassword });
      const reset = await db.one<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1`,
        [hashResetToken(token)],
      );
      if (!reset) return res.status(400).json({ error: "invalid_token", message: "重置链接无效或已过期" });
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await db.tx(async (tx) => {
        await tx.query("UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2", [passwordHash, reset.user_id]);
        await tx.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [reset.id]);
      });
      return res.json({ ok: true, message: "密码已更新，请使用新密码登录" });
    }),
  );

  router.get(
    "/auth/verify",
    asyncRoute(async (req, res) => {
      const token = String(req.query.token || "").trim();
      const match = await db.one<{ id: string; user_id: string; email: string; username: string | null; email_verified_at: string | null; token_version: number }>(
        `SELECT t.id, t.user_id, u.email, u.username, u.email_verified_at, u.token_version
         FROM email_verification_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.used_at IS NULL AND expires_at > now() LIMIT 1`,
        [hashResetToken(token)],
      );
      if (!match) {
        return res.status(400).type("html").send(verifyErrorPage("验证链接无效或已过期"));
      }
      await db.tx(async (tx) => {
        await tx.query("UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL", [match.user_id]);
        await tx.query("UPDATE email_verification_tokens SET used_at = now() WHERE id = $1", [match.id]);
      });
      writeSessionCookie(req, res, signToken({
        id: match.user_id,
        email: match.email,
        token_version: match.token_version,
      }));
      return res.type("html").send(verifySuccessPage());
    }),
  );

  router.get("/auth/reset", (_req, res) => {
    res.type("html").send(resetPasswordPage());
  });

  /** Kept from qingzhou: the post-verification username step. */
  router.post(
    "/auth/username",
    asyncRoute(async (req, res) => {
      const found = await userFromRequest(db, req);
      if (!found) return res.status(401).json({ error: "unauthorized", message: "请先登录" });
      if (needsEmailVerification(found.user) && verificationRequired()) {
        return res.status(403).json({ error: "email_unverified", message: "请先完成邮箱验证" });
      }
      const username = normalizeUsername(req.body?.username);
      if (!username) return res.status(400).json({ error: "invalid_username", message: "请填写 1 到 20 个字符的用户名" });
      await db.query("UPDATE users SET username = $1, updated_at = now() WHERE id = $2", [username, found.user.id]);
      return res.json({ user: { ...publicUser(found.user), username, emailVerified: true } });
    }),
  );

  return router;
}

export { assertDirectMailEnv };
