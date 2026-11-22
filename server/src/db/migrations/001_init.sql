-- BOAT P1 schema (§6.1-§6.4). PostgreSQL. Ordered migration, applied once.
-- All business days are Asia/Shanghai calendar days, computed by the server.

-- 6.1 Accounts (migrated from MySQL; original CHAR(36) UUID values are preserved)
CREATE TABLE IF NOT EXISTS users (
  id                 uuid PRIMARY KEY,
  email              text NOT NULL UNIQUE,
  password_hash      text NOT NULL,
  username           text,
  email_verified_at  timestamptz,
  token_version      integer NOT NULL DEFAULT 0,
  role               text NOT NULL DEFAULT 'user',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verify_user ON email_verification_tokens(user_id);

-- Optimistic-lock timestamp is truncated to milliseconds by the server (§6.1 note).
CREATE TABLE IF NOT EXISTS user_app_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6.2 Profile (F-S2: gender -> water -> birth YYYY-MM -> cloud consent; NO goals)
CREATE TABLE IF NOT EXISTS user_profile (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gender         text CHECK (gender IN ('female','male','custom')),
  water_goal_ml  integer CHECK (water_goal_ml BETWEEN 500 AND 6000),
  birth_ym       char(7),
  weight_kg      numeric(5,1),
  weight_skipped boolean NOT NULL DEFAULT false,
  cloud_consent  boolean,
  onboarded_at   timestamptz,
  pending        jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_device_user ON device_tokens(user_id);

-- 6.3 Wellness (rebuilt from SQLite; `food` keeps the original kind spelling)
CREATE TABLE IF NOT EXISTS wellness_entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('food','water','sleep','exercise')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source_text text,
  estimated boolean NOT NULL DEFAULT false,
  kcal numeric NOT NULL DEFAULT 0,
  kcal_low numeric,
  kcal_high numeric,
  protein_g numeric NOT NULL DEFAULT 0,
  carb_g numeric NOT NULL DEFAULT 0,
  fat_g numeric NOT NULL DEFAULT 0,
  water_ml numeric NOT NULL DEFAULT 0,
  sleep_min integer NOT NULL DEFAULT 0,
  exercise_min integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL,
  kb_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wellness_user_day ON wellness_entries(user_id, day);

CREATE TABLE IF NOT EXISTS wellness_day_settings (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  water_goal_ml integer,
  suggestion_applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  day date,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON chat_messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS usage_calls (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  month char(7) NOT NULL,
  day date NOT NULL,
  kind text NOT NULL,
  model text NOT NULL,
  prompt_tokens integer NOT NULL,
  completion_tokens integer NOT NULL,
  cached_tokens integer NOT NULL,
  miss_tokens integer NOT NULL,
  peak boolean NOT NULL,
  cost_li integer NOT NULL,
  status text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user_month ON usage_calls(user_id, month);

CREATE TABLE IF NOT EXISTS parse_cache (
  cache_key text PRIMARY KEY,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The old `events` table was a metric log, renamed to avoid confusion with memory facts.
CREATE TABLE IF NOT EXISTS metric_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  day date NOT NULL,
  kind text NOT NULL,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS idx_metric_user_day ON metric_events(user_id, day);

-- 6.4 Expenses (split out of the JSON document), Routine, Focus, Daily reports
CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  kind text NOT NULL DEFAULT 'expense',
  note text NOT NULL DEFAULT '',
  category text,
  spent_at timestamptz NOT NULL DEFAULT now(),
  day date NOT NULL,
  source text NOT NULL DEFAULT 'form',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_expenses_user_day ON expenses(user_id, day);

CREATE TABLE IF NOT EXISTS routines (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-day completion state; solves "回看今日完成情况" (M05-F2).
CREATE TABLE IF NOT EXISTS routine_checks (
  routine_id uuid REFERENCES routines(id) ON DELETE CASCADE,
  day date NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (routine_id, day)
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_ref text,
  planned_sec integer NOT NULL CHECK (planned_sec BETWEEN 60 AND 14400),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','paused','done','abandoned')),
  elapsed_sec integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'web'
);
CREATE INDEX IF NOT EXISTS idx_focus_user_status ON focus_sessions(user_id, status);

CREATE TABLE IF NOT EXISTS daily_reports (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  stats jsonb NOT NULL,
  narrative text,
  diary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- WP3.1 personal correction layer (knowledge base first phase)
CREATE TABLE IF NOT EXISTS personal_foods (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  alias text NOT NULL DEFAULT '',
  correction_factor numeric(4,2) NOT NULL DEFAULT 1.0
    CHECK (correction_factor BETWEEN 0.5 AND 2.0),
  typical_portion_g integer,
  confirmations integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

-- Account hygiene: mark pre-verification accounts as verified if they have no pending token.
UPDATE users AS u
SET email_verified_at = u.created_at
WHERE u.email_verified_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM email_verification_tokens t
    WHERE t.user_id = u.id AND t.used_at IS NULL
  );
