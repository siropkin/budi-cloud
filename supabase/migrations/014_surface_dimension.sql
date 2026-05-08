-- Surface dimension (#187): track which IDE / CLI ("surface") the daemon was
-- driving when each rollup or session was recorded — `vscode`, `cursor`,
-- `jetbrains`, `terminal`, …. Lets the dashboard answer "where is our team
-- AI-coding?" and lets a manager filter every chart to a single surface for
-- the rollout-comparison story (siropkin/budi-cloud#187).
--
-- The local-side `surface` column lands in budi-core via siropkin/budi#701
-- and the canonical wire shape is defined by siropkin/budi#702. Cloud is
-- forward-compatible: until core starts sending `surface`, every rollup /
-- session row backfills to the literal `'unknown'` and all-surface
-- aggregations keep their existing answer.
--
-- Why `'unknown'` (not NULL):
--   1. The PK on `daily_rollups` has to extend to include `surface` so two
--      surfaces on the same `(device, day, role, provider, model, repo,
--      branch)` combo don't UPSERT-collide. PK columns must be NOT NULL, so
--      we pick a literal sentinel that round-trips cleanly through PostgREST
--      and matches the dashboard's "rows from pre-bump daemons display as
--      unknown" rule from the ticket.
--   2. Filtering becomes a simple `surface = ANY(p_surfaces)` rather than a
--      `(surface IS NULL OR surface = ANY(...))` disjunction every RPC has to
--      remember.
--
-- Sessions are 1:1 with `(device_id, session_id)` — surface is a property of
-- the session itself, not a partitioning dimension. We still default to
-- `'unknown'` for symmetry with `daily_rollups` so DAL filters never have to
-- branch on null vs. literal.

-- ============================================================
-- 1. daily_rollups
-- ============================================================
ALTER TABLE daily_rollups
    ADD COLUMN surface TEXT NOT NULL DEFAULT 'unknown';

-- Extend the PK so a daemon that ships rollups from two surfaces on the same
-- (device, day, role, provider, model, repo, branch) combo doesn't have one
-- silently overwrite the other on UPSERT. Existing rows backfill to
-- 'unknown', so no PK collision is possible during the constraint swap.
ALTER TABLE daily_rollups DROP CONSTRAINT daily_rollups_pkey;
ALTER TABLE daily_rollups
    ADD CONSTRAINT daily_rollups_pkey PRIMARY KEY (
        device_id, bucket_day, role, provider, model, repo_id, git_branch, surface
    );

-- ============================================================
-- 2. session_summaries
-- ============================================================
ALTER TABLE session_summaries
    ADD COLUMN surface TEXT NOT NULL DEFAULT 'unknown';
