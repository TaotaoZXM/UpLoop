-- Per-task flower counts tapped on the small square screen. Kept out of user_app_state
-- (the web client rewrites that document from its own fields and would drop unknown keys).
CREATE TABLE IF NOT EXISTS task_flowers (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_flowers_user ON task_flowers(user_id);
