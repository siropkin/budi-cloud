-- Per-session "main" model (#140).
--
-- The dashboard's Sessions list and detail pages show **provider** (e.g.
-- `claude_code`) but never the model that was actually used. Two sessions
-- on the same provider that differ only in model (Opus vs Haiku) are
-- indistinguishable even though their cost/quality profiles diverge wildly.
-- The daily-rollups surfaces already break out per-model spend because
-- `daily_rollups.model` exists; sessions are the odd one out.
--
-- A real session can span multiple models — Claude Code fans out to a
-- smaller sub-agent, and providers fall back on context overflow / rate
-- limits. The daemon picks ONE main model per session: the model that
-- consumed the largest share of total (input + output) tokens, ties broken
-- by latest-used. That single string ships in the ingest envelope as
-- `primary_model` and lands here as `main_model`.
--
-- The column is NULLABLE because:
--   1. Older daemons (< 8.3.16) won't send `primary_model`. The dashboard
--      renders an em-dash for those rows, mirroring how the vitals columns
--      from #99 degrade.
--   2. Sessions with zero scored messages legitimately have no model to
--      report — the daemon omits the field rather than guessing.
--
-- No PK / index change. The column is for display only in v1; sessions
-- aren't filtered by model. If filtering is wanted later, add the index
-- alongside that feature.

ALTER TABLE session_summaries
    ADD COLUMN main_model TEXT;
