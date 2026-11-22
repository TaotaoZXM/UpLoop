/**
 * WP2.5 / F-S7: long-lived, revocable device tokens for the small square screen.
 * Same account system, same rate limiting and same usage accounting as the web app.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { asyncRoute } from "../http.js";
import { authUser, DEVICE_PREFIX, hashDeviceToken } from "../auth/session.js";
import { HttpError } from "../errors.js";
import type { AppDeps } from "../types.js";

export async function createDeviceToken(db: AppDeps["db"], userId: string, label: string) {
  const clean = String(label || "").trim().slice(0, 40) || "小方屏";
  const token = `${DEVICE_PREFIX}${randomBytes(24).toString("hex")}`;
  const id = randomUUID();
  await db.query(
    `INSERT INTO device_tokens (id, user_id, token_hash, token_prefix, label)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, userId, hashDeviceToken(token), token.slice(0, 12), clean],
  );
  // Plaintext is returned exactly once and never stored.
  return { id, token, tokenPrefix: token.slice(0, 12), label: clean };
}

export function createDeviceRouter({ db }: AppDeps) {
  const router = Router();

  router.get(
    "/device-tokens",
    asyncRoute(async (req, res) => {
      const rows = await db.rows<{ id: string; token_prefix: string; label: string; created_at: unknown; last_used_at: unknown; revoked_at: unknown }>(
        `SELECT id, token_prefix, label, created_at, last_used_at, revoked_at
         FROM device_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
        [authUser(req).id],
      );
      return res.json({ tokens: rows });
    }),
  );

  router.post(
    "/device-tokens",
    asyncRoute(async (req, res) => {
      const created = await createDeviceToken(db, authUser(req).id, String(req.body?.label || ""));
      return res.status(201).json(created);
    }),
  );

  router.delete(
    "/device-tokens/:id",
    asyncRoute(async (req, res) => {
      const result = await db.query(
        "UPDATE device_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        [req.params.id, authUser(req).id],
      );
      if (!result.rowCount) throw new HttpError(404, "not_found", "没有这个设备令牌");
      return res.json({ ok: true, revoked: true });
    }),
  );

  return router;
}
