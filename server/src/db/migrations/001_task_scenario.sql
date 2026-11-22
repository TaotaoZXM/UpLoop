ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS scenario text NOT NULL DEFAULT 'life';

ALTER TABLE routines
  DROP CONSTRAINT IF EXISTS routines_scenario_check;

ALTER TABLE routines
  ADD CONSTRAINT routines_scenario_check CHECK (scenario IN ('life', 'work', 'rest'));
