-- Align Overview's `total_sessions` with the cost/tokens/messages totals on
-- the same row (#155).
--
-- Pre-#155 the function counted sessions whose `started_at` fell inside a
-- precise TIMESTAMPTZ window (`p_started_from..p_started_to`), while every
-- other column on the same row summed `daily_rollups` over a calendar-day
-- range (`p_bucket_from..p_bucket_to`). Two structural reasons made the
-- session count collapse to zero on narrow windows where the rollup-sourced
-- columns still showed real numbers:
--
--   1. `session_summaries.started_at` is nullable (`001_ingest_schema.sql`);
--      any row with `started_at IS NULL` was silently excluded by `BETWEEN`,
--      while the corresponding `daily_rollups` row (keyed by `bucket_day`)
--      still counted toward cost/tokens/messages.
--   2. The TIMESTAMPTZ window is narrower than the `bucket_day` window — the
--      latter widens by up to one UTC day on the earlier edge to capture all
--      buckets overlapping the viewer's local-TZ day (`src/lib/timezone.ts`),
--      so a session whose `started_at` is just outside the precise window
--      could still have its rollup row included on the cost/tokens side.
--
-- On `?days=1` the previous-period window is two calendar days; either bias
-- alone could (and did, per #155) collapse the previous count to zero,
-- producing the `—` sentinel in `fmtDelta` (`src/lib/format.ts:89-104`)
-- while every other card on the same row showed a real percentage.
--
-- The fix is to drive both sources off the same date key. We keep the count
-- on `session_summaries` (no rollup-side `session_count` column to add yet)
-- and:
--   - filter on `COALESCE(started_at, ended_at, synced_at)::date` so a row
--     with NULL `started_at` falls back to the next non-null timestamp
--     instead of disappearing,
--   - compare that date against `p_bucket_from..p_bucket_to`, the same
--     `bucket_day` range the rollup totals use.
--
-- Postgres won't let `CREATE OR REPLACE FUNCTION` change a function's
-- argument list (signature is part of identity), so we drop the old shape
-- first; the next CREATE re-establishes it without the obsolete
-- `p_started_from` / `p_started_to` parameters.

DROP FUNCTION IF EXISTS public.dashboard_overview_stats(TEXT[], DATE, DATE, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.dashboard_overview_stats(
    p_device_ids   TEXT[],
    p_bucket_from  DATE,
    p_bucket_to    DATE
)
RETURNS TABLE (
    total_cost_cents     NUMERIC,
    total_input_tokens   BIGINT,
    total_output_tokens  BIGINT,
    total_messages       BIGINT,
    total_sessions       BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH r AS (
        SELECT
            COALESCE(SUM(cost_cents), 0)             AS total_cost_cents,
            COALESCE(SUM(input_tokens), 0)::BIGINT   AS total_input_tokens,
            COALESCE(SUM(output_tokens), 0)::BIGINT  AS total_output_tokens,
            COALESCE(SUM(message_count), 0)::BIGINT  AS total_messages
        FROM daily_rollups
        WHERE device_id = ANY(p_device_ids)
          AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    ),
    s AS (
        SELECT COUNT(*)::BIGINT AS total_sessions
        FROM session_summaries
        WHERE device_id = ANY(p_device_ids)
          AND COALESCE(started_at, ended_at, synced_at)::date
              BETWEEN p_bucket_from AND p_bucket_to
    )
    SELECT r.total_cost_cents, r.total_input_tokens, r.total_output_tokens,
           r.total_messages, s.total_sessions
    FROM r, s;
$$;
