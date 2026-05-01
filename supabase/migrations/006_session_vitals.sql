-- Per-session vital scores (#99).
--
-- The local CLI renders four vitals on `budi sessions <id>`:
--   - Prompt Growth      (context-window growth rate)
--   - Cache Reuse        (cache-read efficiency)
--   - Retry Loops        (assistant thrashing / retry rate)
--   - Cost Acceleration  (cost per assistant turn, derivative)
-- backed by `session_health` in budi-core. The marketing site advertises
-- these as a budi feature, but the cloud envelope did not carry them, so a
-- manager looking at the team dashboard could not see *which* sessions were
-- bloating even though every individual user could see it locally.
--
-- This migration extends `session_summaries` with the four state colours,
-- their numeric metrics, and the rolled-up `overall_state`. Per the privacy
-- review tracked in ADR-0083 §1, **only** the score (green/yellow/red),
-- the numeric metric, and the overall state cross the wire — no prompt
-- content, no per-message data, no file paths.
--
-- All columns are NULLABLE because:
--   1. Older daemons (< 8.3.15) won't emit these fields. The dashboard
--      degrades by rendering a "Vitals not yet available — upgrade local
--      daemon to ≥ 8.3.15" notice rather than 5xxing.
--   2. Sessions with too few assistant messages legitimately have no vital
--      score to report; budi-core skips emission rather than guessing.
--
-- A single CHECK CONSTRAINT pins the four state columns + overall_state to
-- the colour vocabulary so a daemon-side regression that ships
-- `"yelllow"` (sic) gets bounced at write time rather than silently
-- rendering as an unknown badge.

ALTER TABLE session_summaries
    ADD COLUMN vital_context_drag_state       TEXT,
    ADD COLUMN vital_context_drag_metric      NUMERIC(12,4),
    ADD COLUMN vital_cache_efficiency_state   TEXT,
    ADD COLUMN vital_cache_efficiency_metric  NUMERIC(12,4),
    ADD COLUMN vital_thrashing_state          TEXT,
    ADD COLUMN vital_thrashing_metric         NUMERIC(12,4),
    ADD COLUMN vital_cost_acceleration_state  TEXT,
    ADD COLUMN vital_cost_acceleration_metric NUMERIC(12,4),
    ADD COLUMN vital_overall_state            TEXT;

ALTER TABLE session_summaries
    ADD CONSTRAINT session_summaries_vital_states_check CHECK (
        (vital_context_drag_state      IS NULL OR vital_context_drag_state      IN ('green', 'yellow', 'red'))
        AND (vital_cache_efficiency_state  IS NULL OR vital_cache_efficiency_state  IN ('green', 'yellow', 'red'))
        AND (vital_thrashing_state         IS NULL OR vital_thrashing_state         IN ('green', 'yellow', 'red'))
        AND (vital_cost_acceleration_state IS NULL OR vital_cost_acceleration_state IN ('green', 'yellow', 'red'))
        AND (vital_overall_state           IS NULL OR vital_overall_state           IN ('green', 'yellow', 'red'))
    );
