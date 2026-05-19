-- #340: Cloud sessions filter should include sessions with recent activity
--
-- The Sessions page previously filtered on `started_at`, so a session that
-- started months ago but has new turns today was invisible in the 1d / 7d
-- views.  Fix: a stored generated column `last_active_at` that both the
-- time-period filter and the cursor-based sort can target.  This matches the
-- local statusline's cost_1d / cost_7d / cost_30d computation which uses
-- message timestamps, not session creation time.

ALTER TABLE session_summaries
  ADD COLUMN last_active_at TIMESTAMPTZ
  GENERATED ALWAYS AS (COALESCE(ended_at, started_at)) STORED;

CREATE INDEX idx_session_summaries_last_active_at
    ON session_summaries (last_active_at);
