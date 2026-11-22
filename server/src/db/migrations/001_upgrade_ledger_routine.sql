-- Compatibility for databases that ran 001 before income and ordered steps.
-- Kept in release 001 so the optional ltree/memory migration is not required.
-- IF NOT EXISTS preserves existing income types and steps on current databases.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'expense';
ALTER TABLE routines ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;
