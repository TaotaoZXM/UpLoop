import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** WP1.3: one loader for the merged app. Never import fitness-helper's hand-rolled loader. */
const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadEnv() {
  dotenv.config({ path: join(serverRoot, ".env") });
  dotenv.config({ path: join(serverRoot, "..", ".env") });
}

loadEnv();

function int(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name: string) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * D1.11 / WP2.3: ¥50 per month, warn at 80%, hard stop at 100%.
 * Configurable because PRD §8 open question 1 (whether to raise the cap) is undecided.
 */
/**
 * `BASE_PATH` is the single source of truth for the URL mount prefix: routes,
 * the injected <base>, the session cookie Path and the email links all read
 * it. The local demo defaults to "/task". Leave it empty for root hosting.
 *
 * Normalised so callers never have to guess about slashes: "/task/", "task"
 * and "/task" all become "/task"; "/" and "" become "".
 */
function normalizeBasePath(raw: unknown) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "").replace(/^\/+/, "");
  return trimmed ? `/${trimmed}` : "";
}

export const LIMIT_YUAN = int("LIMIT_YUAN", 50);
export const WARN_YUAN = int("WARN_YUAN", 40);
export const LI_PER_YUAN = int("LI_PER_YUAN", 1000);
export const CATALOG_VERSION = int("CATALOG_VERSION", 1);

const basePath = normalizeBasePath(process.env.BASE_PATH);

export const env = {
  /** Suspended module: opt in explicitly to restore its UI and record paths. */
  wellnessEnabled: process.env.WELLNESS_ENABLED === "1",
  taskReflectionEnabled: process.env.TASK_REFLECTION_ENABLED === "1",
  databaseUrl: process.env.DATABASE_URL?.trim() || "",
  jwtSecret: process.env.JWT_SECRET?.trim() || "",
  /** fitness-helper's SECRET, renamed per WP1.3. Only used for device-token hashing. */
  deviceTokenSecret: (() => {
    const configured = process.env.DEVICE_TOKEN_SECRET?.trim();
    if (configured) return configured;
    if (process.env.NODE_ENV === "production") {
      throw new Error("DEVICE_TOKEN_SECRET is required in production");
    }
    return "dev-only-device-secret-change-me";
  })(),
  asrKey: process.env.DASHSCOPE_API_KEY?.trim() || "",
  asrBase: (process.env.ASR_BASE_URL || "https://dashscope.aliyuncs.com/api/v1").replace(/\/$/, ""),
  asrModel: process.env.ASR_MODEL?.trim() || "fun-asr",
  asrYuanPerSecond: Math.max(0.000001, int("ASR_YUAN_PER_SECOND", 0.00022)),
  // Encouragement speech (Qwen-TTS). Reuses the DashScope key and base URL above.
  ttsModel: process.env.TTS_MODEL?.trim() || "qwen3-tts-flash",
  ttsVoice: process.env.TTS_VOICE?.trim() || "Cherry",
  // Placeholder rate for the usage meter: check the current price on the Bailian console and set TTS_YUAN_PER_CHAR.
  ttsYuanPerChar: Math.max(0.000001, int("TTS_YUAN_PER_CHAR", 0.0002)),
  deepseekKey: process.env.DEEPSEEK_API_KEY?.trim() || "",
  deepseekModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
  deepseekBase: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
  cookieSecure: process.env.COOKIE_SECURE === "1",
  nodeEnv: process.env.NODE_ENV || "development",
  /** HTTP listen port. The local demo script overrides this to 8896. */
  port: int("PORT", 3200),
  host: process.env.HOST || "127.0.0.1",
  basePath,
  /** Absolute prefix every internal URL must carry. Always ends with "/". */
  baseUrlPath: basePath ? `${basePath}/` : "/",
  appPublicUrl: process.env.APP_PUBLIC_URL?.trim() || "",
  emailDelivery: process.env.EMAIL_DELIVERY?.trim() || "",
  exposeDevLinks: process.env.EXPOSE_DEV_LINKS === "1",
  physiologyFlag: process.env.PHYSIOLOGY_API === "1",
  serveStatic: process.env.SERVE_STATIC ? process.env.SERVE_STATIC === "1" : process.env.NODE_ENV !== "production",
  /** WP2.5: CORS for /v1 is no longer `*`. An empty list means same-origin only. */
  v1CorsOrigins: list("V1_CORS_ORIGINS"),
  /** WP2.5 Q8: start at 20 chat requests per minute. */
  chatRatePerMinute: int("CHAT_RATE_PER_MINUTE", 20),
  adminUsername: process.env.ADMIN_USERNAME?.trim() || "",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH?.trim() || "",
  /** Extra food catalog JSON, same convention as fitness-helper. */
  dataDir: process.env.DATA_DIR?.trim() || join(serverRoot, "data"),
  /**
   * Migration cap: stops at 001 by default. 002 needs the PostgreSQL ltree
   * extension; set MIGRATE_MAX=002 only after checking
   * pg_available_extensions.
   */
  migrateMax: process.env.MIGRATE_MAX?.trim() || "001",
} as const;

export function assertRuntimeEnv() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required");
  if (env.jwtSecret.length < 16) throw new Error("JWT_SECRET must be at least 16 characters");
}
