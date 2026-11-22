/**
 * WP2.7 / F-S6: one-click export and account deletion.
 * Export excludes password_hash, all token hashes, usage_calls and metric_events.
 * Deletion is a single transaction using ON DELETE CASCADE, plus explicit session
 * invalidation and device-token revocation.
 */
import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../http.js";
import { authUser, clearSessionCookie } from "../auth/session.js";
import { readJson } from "../db/pool.js";
import { todayShanghai } from "../wellness/logic/time.js";
import { isMemoryEnabled } from "../memory/projection.js";
import type { AppDeps } from "../types.js";

/**
 * §10 privacy assertion: every table holding a user_id is listed here so tests
 * can iterate them and catch a future table that forgets ON DELETE CASCADE.
 */
export const PRIVACY_CHECKS: Array<{ table: string; sql: string }> = [
  { table: "voice_requests", sql: "SELECT COUNT(*)::int AS n FROM voice_requests WHERE user_id = $1" },
  { table: "users", sql: "SELECT COUNT(*)::int AS n FROM users WHERE id = $1" },
  { table: "password_reset_tokens", sql: "SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1" },
  { table: "email_verification_tokens", sql: "SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id = $1" },
  { table: "user_app_state", sql: "SELECT COUNT(*)::int AS n FROM user_app_state WHERE user_id = $1" },
  { table: "user_profile", sql: "SELECT COUNT(*)::int AS n FROM user_profile WHERE user_id = $1" },
  { table: "device_tokens", sql: "SELECT COUNT(*)::int AS n FROM device_tokens WHERE user_id = $1" },
  { table: "wellness_entries", sql: "SELECT COUNT(*)::int AS n FROM wellness_entries WHERE user_id = $1" },
  { table: "wellness_day_settings", sql: "SELECT COUNT(*)::int AS n FROM wellness_day_settings WHERE user_id = $1" },
  { table: "chat_messages", sql: "SELECT COUNT(*)::int AS n FROM chat_messages WHERE user_id = $1" },
  { table: "expenses", sql: "SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1" },
  { table: "routines", sql: "SELECT COUNT(*)::int AS n FROM routines WHERE user_id = $1" },
  { table: "routine_checks", sql: "SELECT COUNT(*)::int AS n FROM routine_checks c JOIN routines r ON r.id = c.routine_id WHERE r.user_id = $1" },
  { table: "focus_sessions", sql: "SELECT COUNT(*)::int AS n FROM focus_sessions WHERE user_id = $1" },
  { table: "daily_reports", sql: "SELECT COUNT(*)::int AS n FROM daily_reports WHERE user_id = $1" },
  { table: "personal_foods", sql: "SELECT COUNT(*)::int AS n FROM personal_foods WHERE user_id = $1" },
  { table: "usage_calls", sql: "SELECT COUNT(*)::int AS n FROM usage_calls WHERE user_id = $1" },
  { table: "life_events", sql: "SELECT COUNT(*)::int AS n FROM life_events WHERE user_id = $1" },
  { table: "memory_nodes", sql: "SELECT COUNT(*)::int AS n FROM memory_nodes WHERE user_id = $1" },
  { table: "profile_facts", sql: "SELECT COUNT(*)::int AS n FROM profile_facts WHERE user_id = $1" },
];

export async function buildExport(db: AppDeps["db"], userId: string) {
  const user = await db.one<{ id: string; email: string; username: string | null; email_verified_at: unknown; role: string }>(
    "SELECT id, email, username, email_verified_at, role FROM users WHERE id = $1",
    [userId],
  );
  const query = async (sql: string) => db.rows<Record<string, unknown>>(sql, [userId]);
  const [profile, state, wellness, messages, expenses, routines, checks, focus, reports, personal, facts, lifeEvents, voiceRequests] =
    await Promise.all([
      query("SELECT * FROM user_profile WHERE user_id = $1"),
      query("SELECT state, updated_at FROM user_app_state WHERE user_id = $1"),
      query("SELECT * FROM wellness_entries WHERE user_id = $1 ORDER BY occurred_at"),
      query("SELECT id, role, content, day, meta, created_at FROM chat_messages WHERE user_id = $1 ORDER BY created_at"),
      query("SELECT id, amount_cents, kind, note, category, spent_at, day, source FROM expenses WHERE user_id = $1 ORDER BY spent_at"),
      query("SELECT id, title, steps, sort_order, created_at FROM routines WHERE user_id = $1 ORDER BY sort_order"),
      query("SELECT c.routine_id, c.day, c.checked_at FROM routine_checks c JOIN routines r ON r.id = c.routine_id WHERE r.user_id = $1"),
      query("SELECT id, task_ref, planned_sec, started_at, ended_at, status, elapsed_sec, source FROM focus_sessions WHERE user_id = $1"),
      query("SELECT day, stats, narrative, diary, created_at FROM daily_reports WHERE user_id = $1"),
      query("SELECT name, alias, correction_factor, typical_portion_g, confirmations FROM personal_foods WHERE user_id = $1"),
      isMemoryEnabled() ? query("SELECT category, statement, confidence, status, first_seen, last_confirmed FROM profile_facts WHERE user_id = $1") : Promise.resolve([]),
      isMemoryEnabled() ? query("SELECT type, day, payload, is_sensitive FROM life_events WHERE user_id = $1") : Promise.resolve([]),
      query("SELECT request_id, result, created_at FROM voice_requests WHERE user_id = $1 ORDER BY created_at"),
    ]);
  return {
    exportedAt: new Date().toISOString(),
    product: "UpLoop",
    user: user ? {
      id: user.id, email: user.email, username: user.username,
      emailVerifiedAt: user.email_verified_at, role: user.role,
    } : null,
    profile,
    state: state[0] ? { ...state[0], state: readJson<unknown>(state[0].state, {}) } : null,
    wellnessEntries: wellness,
    chatMessages: messages,
    expenses,
    routines,
    routineChecks: checks,
    focusSessions: focus,
    dailyReports: reports,
    personalFoods: personal,
    profileFacts: facts,
    lifeEvents,
    voiceRequests,
  };
}

export function createAccountRouter({ db }: AppDeps) {
  const router = Router();

  router.get(
    "/export",
    asyncRoute(async (req, res) => {
      const payload = await buildExport(db, authUser(req).id);
      res.setHeader("Content-Disposition", `attachment; filename="task-${todayShanghai()}.json"`);
      return res.json(payload);
    }),
  );

  router.delete(
    "/account",
    asyncRoute(async (req: Request, res: Response) => {
      if (req.body?.confirm !== "删除") {
        return res.status(400).json({ error: "confirm", message: "请确认删除" });
      }
      const user = authUser(req);
      await db.tx(async (tx) => {
        await tx.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [user.id]);
        await tx.query("UPDATE device_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
        await tx.query("DELETE FROM users WHERE id = $1", [user.id]);
      });
      clearSessionCookie(req, res);
      return res.json({ ok: true, deleted: true });
    }),
  );

  return router;
}
