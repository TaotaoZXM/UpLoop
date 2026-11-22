import { randomUUID } from "node:crypto";
import type { Db } from "../db/pool.js";

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const PLAIN_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function adminUsernameFromEnv() {
  return String(process.env.ADMIN_USERNAME || "").trim();
}

export function adminPasswordHashFromEnv() {
  return String(process.env.ADMIN_PASSWORD_HASH || "").trim();
}

function assertAdminConfig(username: string, passwordHash: string) {
  if (!PLAIN_USERNAME.test(username)) {
    throw new Error("ADMIN_USERNAME must be a plain username such as admin, not an email");
  }
  if (!BCRYPT_HASH.test(passwordHash)) {
    throw new Error("ADMIN_PASSWORD_HASH must be a bcrypt hash from server/scripts/hash-password.js");
  }
}

type AdminRow = { id: string; password_hash: string; email_verified_at: string | null; role: string };

/** WP1.2 §11.6: IF(...) replaced by COALESCE. */
export async function ensureAdminUser(db: Db) {
  const username = adminUsernameFromEnv();
  const passwordHash = adminPasswordHashFromEnv();
  if (!username && !passwordHash) return false;
  if (!username || !passwordHash) throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD_HASH must both be set");
  assertAdminConfig(username, passwordHash);

  const load = () =>
    db.one<AdminRow>(
      "SELECT id, password_hash, email_verified_at, role FROM users WHERE email = $1 LIMIT 1",
      [username],
    );

  let existing = await load();
  if (!existing) {
    try {
      await db.query(
        "INSERT INTO users (id, email, password_hash, email_verified_at, role) VALUES ($1, $2, $3, now(), 'admin')",
        [randomUUID(), username, passwordHash],
      );
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      existing = await load();
    }
  }
  if (!existing) throw new Error("admin account could not be saved");
  const sameHash = existing.password_hash === passwordHash;
  const verified = Boolean(existing.email_verified_at);
  if (sameHash && verified && existing.role === "admin") return false;
  await db.query(
    `UPDATE users
     SET role = 'admin',
         password_hash = $1,
         email_verified_at = COALESCE(email_verified_at, now()),
         token_version = token_version + $2
     WHERE id = $3`,
    [passwordHash, sameHash ? 0 : 1, existing.id],
  );
  return true;
}
