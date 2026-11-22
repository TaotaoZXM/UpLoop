-- BOAT WP3.2 memory layer (§6.5). P3 / optional in P1.
-- BLOCKING PREREQUISITE (§13 Q1, unverified): the RDS PostgreSQL instance must allow
-- `CREATE EXTENSION ltree`. Verify with:
--   SELECT * FROM pg_available_extensions WHERE name = 'ltree';
-- If it is unavailable, run P1 with MIGRATE_MAX=001 and stop here.
CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE IF NOT EXISTS life_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  day date NOT NULL,
  occurred_at timestamptz NOT NULL,
  ref_table text NOT NULL DEFAULT '',
  ref_id text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, ref_table, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_life_events_user_day ON life_events(user_id, day);

CREATE TABLE IF NOT EXISTS memory_nodes (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('day','week','month')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  path ltree NOT NULL,
  stats jsonb NOT NULL,
  summary text,
  anomalies jsonb,
  dirty boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (user_id, level, period_start)
);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_path ON memory_nodes USING gist (path);

-- WP3.3 is deferred (PRD: 随 A14 拆任务). The table exists so the privacy/export
-- assertions in §10 can already cover every table holding a user_id.
CREATE TABLE IF NOT EXISTS profile_facts (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL,
  statement text NOT NULL,
  confidence numeric NOT NULL,
  evidence jsonb NOT NULL,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','active','outdated','user_rejected')),
  first_seen date NOT NULL,
  last_confirmed date NOT NULL
);
