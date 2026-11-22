/**
 * UpLoop API. Express + TypeScript + PostgreSQL.
 *
 * Every route, asset, cookie and Service Worker lives under `env.basePath`
 * (the demo default is /task). Setting BASE_PATH="" keeps root hosting for
 * local development and IP access.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createVoiceService } from "./voice/routes.js";
import { createAccountRouter } from "./account/routes.js";
import { ensureAdminUser } from "./auth/admin.js";
import { assertDirectMailEnv } from "./auth/mail.js";
import { createAuthRouter } from "./auth/routes.js";
import { clearSessionCookie, requireAdmin, requireUser } from "./auth/session.js";
import { chatRateLimit, postChatHandler, v1SummaryHandler } from "./chat/routes.js";
import { createDb, type Db } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createDeviceRouter } from "./devices/routes.js";
import { createDeviceCardsRouter } from "./devices/cards.js";
import { assertRuntimeEnv, env } from "./env.js";
import { sendError } from "./http.js";
import { createFocusRouter } from "./focus/routes.js";
import { createLedgerRouter } from "./ledger/routes.js";
import { detectMemoryTables } from "./memory/projection.js";
import { createProfileRouter, requireOnboarded } from "./profile/routes.js";
import { createReportRouter } from "./report/routes.js";
import { createRoutineRouter } from "./routine/routes.js";
import { createDecompositionRouter } from "./tasks/decompose.js";
import { createExtractLinkRouter } from "./tasks/extract-link.js";
import { createStateRouter } from "./state/routes.js";
import type { AppDeps } from "./types.js";
import { adminUsage } from "./usage/quota.js";
import { allAliases, catalogStats, loadCatalogExtras } from "./wellness/logic/catalog.js";
import { createWellnessRouter } from "./wellness/routes.js";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const indexFile = join(webRoot, "index.html");

const PHYSIOLOGY_STUB = {
  enabled: false,
  spo2: null,
  heartRate: null,
  stress: null,
  note: "F-S11 预留：本期不接可穿戴，这些字段保持为空。",
};

function v1Cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin") || "";
  if (origin && env.v1CorsOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
}

/**
 * The shell is served with an injected <base> and window.BT_BASE so the browser
 * and every script learn the mount prefix from the server instead of guessing
 * it. Without this, a deploy under /task/ would request /css/... and /api/...
 * from the host root instead of the mount prefix.
 */
function indexDocument() {
  const html = readFileSync(indexFile, "utf8");
  const base = env.baseUrlPath;
  const injection = `<base href="${base}">\n<script>window.BT_BASE=${JSON.stringify(base)};window.Task_FEATURES=${JSON.stringify({ wellness: env.wellnessEnabled, taskReflection: env.taskReflectionEnabled })};</script>`;
  return /<head(\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}\n${injection}`)
    : `${injection}\n${html}`;
}

function sendIndex(res: Response) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(indexDocument());
}

export function createCore(db: Db, extend?: (app: Express) => void) {
  const deps: AppDeps = { db };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/v1", v1Cors);
  const voice = createVoiceService(deps);
  app.use(voice.publicRouter);

  app.get("/api/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ ok: true, service: "task", ...catalogStats() });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  /** F-S11: exactly one empty physiology stub in the whole repo. */
  app.get("/api/physiology", (_req, res) => {
    res.json({ ...PHYSIOLOGY_STUB, flagged: env.physiologyFlag });
  });

  // Public account endpoints (register/login/verify/reset). /auth/me and
  // /auth/username perform their own token check.
  app.use("/api", createAuthRouter(deps));

  // Everything below requires a session (JWT cookie or taskr_ device token).
  app.use("/api", requireUser(db));
  app.use("/v1", requireUser(db));

  app.use("/api/voice", voice.router);
  app.use("/v1/voice", voice.router);
  app.use("/v1/device", createDeviceCardsRouter(deps));
  app.use("/api", createStateRouter(deps));
  app.use("/api", createDecompositionRouter(deps));
  app.use("/api", createExtractLinkRouter(deps));
  app.use("/api", createProfileRouter(deps));

  const wellnessAvailable: express.RequestHandler = (_req, res, next) => {
    if (!env.wellnessEnabled) return res.status(403).json({ error: "feature_disabled", feature: "wellness", message: "Wellness 已暂停使用，已有数据保留。" });
    next();
  };
  app.use("/api/entries", wellnessAvailable, requireOnboarded(db));
  app.use("/api/wellness", wellnessAvailable, requireOnboarded(db));
  app.use("/api", createWellnessRouter(deps));

  app.use("/api", createLedgerRouter(deps));
  app.use("/api", createRoutineRouter(deps));
  app.use("/api", createFocusRouter(deps));
  app.use("/api", createReportRouter(deps));
  app.use("/api", createDeviceRouter(deps));
  app.use("/api", createAccountRouter(deps));

  app.get("/api/admin/usage", requireAdmin(), async (_req, res) => {
    res.json(await adminUsage(db));
  });

  app.post("/api/chat", chatRateLimit(), postChatHandler(deps, "web"));
  app.post("/v1/chat", chatRateLimit(), postChatHandler(deps, "device"));
  app.get("/v1/summary", v1SummaryHandler(deps));

  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found", message: "接口不存在" }));
  app.use("/v1", (_req, res) => res.status(404).json({ error: "not_found", message: "接口不存在" }));

  // Hook for the demo server: registered before static hosting so its routes
  // are not swallowed by the SPA fallback. Paths are base-relative, because
  // core is mounted under BASE_PATH and Express strips the prefix.
  if (extend) extend(app);

  // Static hosting mirrors nginx. Paths here are already base-stripped, so the
  // same code serves /task/ in production and / locally.
  if (env.serveStatic) {
    // legacy/ is an archived snapshot, never part of the deployed web root.
    const blockedPrefixes = ["/server", "/deploy", "/legacy", "/.git", "/.github", "/node_modules", "/docs"];
    app.use((req, res, next) => {
      let pathName = req.path;
      try {
        pathName = decodeURIComponent(req.path);
      } catch {
        return res.status(404).end();
      }
      const blocked = pathName.includes("..") || pathName === "/.env" || pathName.endsWith("/.env")
        || blockedPrefixes.some((prefix) => pathName === prefix || pathName.startsWith(`${prefix}/`));
      if (blocked) return res.status(404).end();
      return next();
    });
    app.get("/", (_req, res) => sendIndex(res));
    app.get("/index.html", (_req, res) => sendIndex(res));
    app.use(express.static(webRoot, { dotfiles: "ignore", index: false, redirect: false }));
    // Deep links such as /task/todo still return the shell; the client router
    // reads the path and opens the matching screen.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return next();
      return sendIndex(res);
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((error as { type?: string })?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large", message: _req.is("audio/wav") ? "录音过长，请控制在60秒以内" : "请求数据过大，请缩短内容" });
    if ((error as { type?: string })?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json", message: "请求格式不正确" });
    }
    return sendError(res, error);
  });

  return app;
}

/**
 * Mounts the whole app under BASE_PATH. `app.use(prefix, core)` strips the
 * prefix before core sees the request, so no route above has to know about it.
 */
export function createApp(db: Db, extend?: (app: Express) => void) {
  const core = createCore(db, extend);
  const base = env.basePath;
  if (!base) return core;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // "/task" -> "/task/" so the injected <base> and the SW scope line up.
  // Express matches "/task/" here too, hence the exact-path guard.
  app.get(base, (req, res, next) => {
    if (req.path !== base) return next();
    return res.redirect(301, `${base}/${req.originalUrl.slice(req.path.length)}`);
  });
  app.use(base, core);
  app.use((_req, res) => res.status(404).json({ error: "not_found", message: `请访问 ${base}/` }));
  return app;
}

export { clearSessionCookie };

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  assertRuntimeEnv();
  assertDirectMailEnv();
  // WP2.4: aliasOwner collisions must fail fast at startup.
  loadCatalogExtras(env.dataDir);
  allAliases();
  const db = createDb();
  const applied = await migrate(db);
  if (applied) console.log(`[task] migrations applied: ${applied}`);
  if (await detectMemoryTables(db)) console.log("[task] memory layer enabled");
  if (await ensureAdminUser(db)) console.log("[task] admin account ensured");
  const server = createApp(db).listen(env.port, env.host, () => {
    console.log(`UpLoop listening on http://${env.host}:${env.port}${env.baseUrlPath}`);
  });
  const shutdown = async () => {
    server.close();
    await db.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
