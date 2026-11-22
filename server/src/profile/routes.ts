/**
 * WP2.2 / F-S2: mandatory onboarding, exactly four steps:
 *   gender -> water goal -> birth YYYY-MM -> explicit cloud consent.
 * NO goals, NO medical history, NO age band (PRD conflicts ①②③).
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Db } from "../db/pool.js";
import { asyncRoute } from "../http.js";
import { authUser } from "../auth/session.js";
import type { AppDeps, ProfileRow } from "../types.js";
import { env } from "../env.js";

/** Fields that must never re-enter the product (PRD F-S2 / M02-F3). */
export const FORBIDDEN_PROFILE_FIELDS = [
  "goals",
  "goal",
  "target",
  "targets",
  "medical_history",
  "medications",
  "age_band",
  "birth_year",
] as const;

type ProfileBody = Record<string, unknown>;

export function assertNoForbiddenFields(body: ProfileBody) {
  const hit = FORBIDDEN_PROFILE_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (hit) {
    return new Error(`F-S2 forbids the field "${hit}"`);
  }
  return null;
}

export async function loadProfile(db: Db, userId: string): Promise<ProfileRow | null> {
  const row = await db.one<ProfileRow>(
    `SELECT user_id, gender, water_goal_ml, birth_ym, weight_kg, weight_skipped,
            cloud_consent, onboarded_at, pending, updated_at
     FROM user_profile WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  // Consent-only accounts must complete the preserved health onboarding when restored.
  if (row && env.wellnessEnabled && (!row.gender || !row.water_goal_ml || !row.birth_ym)) {
    return { ...row, onboarded_at: null };
  }
  return row || null;
}

export function publicProfile(row: ProfileRow | null) {
  return {
    gender: row?.gender ?? null,
    waterGoalMl: row?.water_goal_ml ?? null,
    birthYm: row?.birth_ym ? String(row.birth_ym).trim() : null,
    weightKg: row?.weight_kg == null ? null : Number(row.weight_kg),
    cloudConsent: row?.cloud_consent ?? null,
    onboarded: Boolean(row?.onboarded_at),
  };
}

/** 403 onboarding_required on chat/records when the four steps are not done. */
export function requireOnboarded(db: Db): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void loadProfile(db, authUser(req).id)
      .then((profile) => {
        if (!profile?.onboarded_at) {
          res.status(403).json({ error: "onboarding_required", message: "先完成开始之前的几件事" });
          return;
        }
        (res.locals as { profile?: ProfileRow }).profile = profile;
        next();
      })
      .catch(next);
  };
}

/** Chat only. Manual Wellness records stay available even without cloud consent. */
export function requireConsent(db: Db): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void loadProfile(db, authUser(req).id)
      .then((profile) => {
        if (!profile?.onboarded_at) {
          res.status(403).json({ error: "onboarding_required", message: "先完成开始之前的几件事" });
          return;
        }
        if (profile.cloud_consent !== true) {
          res.status(403).json({ error: "cloud_consent_required", message: "还没有同意云端处理，对话先不能用" });
          return;
        }
        (res.locals as { profile?: ProfileRow }).profile = profile;
        next();
      })
      .catch(next);
  };
}

function parseGender(value: unknown) {
  const gender = String(value || "").trim();
  return gender === "female" || gender === "male" || gender === "custom" ? gender : null;
}

function parseWater(value: unknown, gender: string) {
  if (value === undefined || value === null || value === "") {
    if (gender === "female") return 1500;
    if (gender === "male") return 1700;
    return null;
  }
  const ml = Number(value);
  if (!Number.isFinite(ml) || ml < 500 || ml > 6000) return null;
  return Math.round(ml);
}

function parseBirthYm(value: unknown, now: Date) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  if (year < 1900 || year > now.getUTCFullYear()) return null;
  return raw;
}

export function createProfileRouter({ db }: AppDeps) {
  const router = Router();

  router.get(
    "/profile",
    asyncRoute(async (req, res) => {
      const profile = await loadProfile(db, authUser(req).id);
      return res.json({ profile: publicProfile(profile), onboardingRequired: !profile?.onboarded_at });
    }),
  );

  router.post(
    "/onboarding",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const body = (req.body || {}) as ProfileBody;
      const forbidden = assertNoForbiddenFields(body);
      if (forbidden) return res.status(400).json({ error: "forbidden_field", message: forbidden.message });
      if (!env.wellnessEnabled) {
        if (typeof body.cloud_consent !== "boolean") return res.status(400).json({ error: "consent", message: "请明确选择是否同意云端处理" });
        const rows = await db.rows<ProfileRow>(
          `INSERT INTO user_profile (user_id, cloud_consent, onboarded_at, updated_at)
           VALUES ($1, $2, now(), now()) ON CONFLICT (user_id) DO UPDATE SET
           cloud_consent = EXCLUDED.cloud_consent, onboarded_at = now(), updated_at = now() RETURNING *`,
          [user.id, body.cloud_consent],
        );
        return res.json({ profile: publicProfile(rows[0] || null), onboardingRequired: false });
      }
      const gender = parseGender(body.gender);
      if (!gender) return res.status(400).json({ error: "gender", message: "请选择性别（女／男／自选）" });
      const waterGoalMl = parseWater(body.water_goal_ml, gender);
      if (waterGoalMl == null) return res.status(400).json({ error: "water", message: "喝水目标请填 500 到 6000 毫升" });
      const birthYm = parseBirthYm(body.birth_ym, new Date());
      if (!birthYm) return res.status(400).json({ error: "birth_ym", message: "请填写出生年月（YYYY-MM）" });
      if (typeof body.cloud_consent !== "boolean") {
        return res.status(400).json({ error: "consent", message: "请明确选择是否同意云端处理" });
      }
      const rows = await db.rows<ProfileRow>(
        `INSERT INTO user_profile
           (user_id, gender, water_goal_ml, birth_ym, cloud_consent, onboarded_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET
           gender = EXCLUDED.gender,
           water_goal_ml = EXCLUDED.water_goal_ml,
           birth_ym = EXCLUDED.birth_ym,
           cloud_consent = EXCLUDED.cloud_consent,
           onboarded_at = now(),
           updated_at = now()
         RETURNING *`,
        [user.id, gender, waterGoalMl, birthYm, body.cloud_consent],
      );
      return res.json({ profile: publicProfile(rows[0] || null), onboardingRequired: false });
    }),
  );

  router.patch(
    "/profile",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const body = (req.body || {}) as ProfileBody;
      const forbidden = assertNoForbiddenFields(body);
      if (forbidden) return res.status(400).json({ error: "forbidden_field", message: forbidden.message });
      const current = await loadProfile(db, user.id);
      if (!current?.onboarded_at) return res.status(403).json({ error: "onboarding_required", message: "先完成开始之前的几件事" });
      if (!env.wellnessEnabled) {
        if (["gender", "water_goal_ml", "birth_ym", "weight_kg"].some(key => key in body)) {
          return res.status(403).json({ error: "feature_disabled", feature: "wellness", message: "Wellness 已暂停，健康资料未修改。" });
        }
        if (typeof body.cloud_consent !== "boolean") return res.status(400).json({ error: "consent", message: "请明确选择是否同意云端处理" });
        const rows = await db.rows<ProfileRow>("UPDATE user_profile SET cloud_consent = $2, updated_at = now() WHERE user_id = $1 RETURNING *", [user.id, body.cloud_consent]);
        return res.json({ profile: publicProfile(rows[0] || null) });
      }

      const gender = body.gender === undefined ? (current.gender || "custom") : parseGender(body.gender);
      if (!gender) return res.status(400).json({ error: "gender", message: "请选择性别（女／男／自选）" });
      const waterGoalMl = body.water_goal_ml === undefined ? current.water_goal_ml : parseWater(body.water_goal_ml, gender);
      if (waterGoalMl == null) return res.status(400).json({ error: "water", message: "喝水目标请填 500 到 6000 毫升" });
      const birthYm = body.birth_ym === undefined
        ? (current.birth_ym ? String(current.birth_ym).trim() : null)
        : parseBirthYm(body.birth_ym, new Date());
      if (!birthYm) return res.status(400).json({ error: "birth_ym", message: "请填写出生年月（YYYY-MM）" });
      let cloudConsent = current.cloud_consent;
      if (body.cloud_consent !== undefined) {
        if (typeof body.cloud_consent !== "boolean") return res.status(400).json({ error: "consent", message: "请明确选择是否同意云端处理" });
        cloudConsent = body.cloud_consent;
      }
      let weightKg = current.weight_kg == null ? null : Number(current.weight_kg);
      if (body.weight_kg !== undefined && body.weight_kg !== null && body.weight_kg !== "") {
        const parsed = Number(body.weight_kg);
        if (!Number.isFinite(parsed) || parsed < 30 || parsed > 250) {
          return res.status(400).json({ error: "weight", message: "体重请填 30 到 250 公斤" });
        }
        weightKg = parsed;
      }
      const rows = await db.rows<ProfileRow>(
        `UPDATE user_profile SET gender = $2, water_goal_ml = $3, birth_ym = $4,
            cloud_consent = $5, weight_kg = $6, updated_at = now()
         WHERE user_id = $1 RETURNING *`,
        [user.id, gender, waterGoalMl, birthYm, cloudConsent, weightKg],
      );
      return res.json({ profile: publicProfile(rows[0] || null) });
    }),
  );

  return router;
}
