import type { Request } from "express";
import type { Db } from "./db/pool.js";

export type AuthUser = {
  id: string;
  email: string;
  username: string | null;
  email_verified_at: string | null;
  token_version: number;
  role: string;
};

export type ProfileRow = {
  user_id: string;
  gender: string | null;
  water_goal_ml: number | null;
  birth_ym: string | null;
  weight_kg: number | null;
  weight_skipped: boolean;
  cloud_consent: boolean | null;
  onboarded_at: string | null;
  pending: unknown;
  updated_at: string;
};

export type AuthedRequest = Request & { user?: AuthUser; viaDevice?: boolean };

/** Dependencies injected into every router. Tests supply a fake Db. */
export type AppDeps = {
  db: Db;
};
