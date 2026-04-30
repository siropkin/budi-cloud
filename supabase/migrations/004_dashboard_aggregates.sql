-- Push dashboard aggregation into Postgres (#92).
--
-- Before this migration every breakdown query in `src/lib/dal.ts` selected raw
-- rollup rows over PostgREST (`.from("daily_rollups").select(...)`) and reduced
-- them to sums in JavaScript. PostgREST imposes a default 1,000-row cap; #15
-- and #90 successively raised it to `.limit(100_000)` for each query. Real-world
-- orgs cross 100,000 rollup rows once `device × day × role × provider × model
-- × repo_id × git_branch` cardinality multiplies out, so the cap recurs and
-- breakdowns fall non-monotonic across time windows.
--
-- The fix is structural: aggregate inside Postgres so no row count is ever
-- exposed to the app. These functions are called via Supabase RPC. Indexes
-- already cover the predicate (`daily_rollups` PK leads with `device_id`,
-- plus `idx_daily_rollups_bucket_day`). Functions are `security definer` so
-- future non-service-role callers don't lose visibility, but the dashboard
-- still uses the service-role admin client and the JS-side scoping in
-- `getVisibleDeviceIds` remains the authoritative gate (per ADR-0083 §6).

-- ============================================================
-- Overview: totals across rollups + session count.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_overview_stats(
    p_device_ids   TEXT[],
    p_bucket_from  DATE,
    p_bucket_to    DATE,
    p_started_from TIMESTAMPTZ,
    p_started_to   TIMESTAMPTZ
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
          AND started_at BETWEEN p_started_from AND p_started_to
    )
    SELECT r.total_cost_cents, r.total_input_tokens, r.total_output_tokens,
           r.total_messages, s.total_sessions
    FROM r, s;
$$;

-- ============================================================
-- Daily activity series for the Overview chart.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_daily_activity(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    bucket_day     DATE,
    input_tokens   BIGINT,
    output_tokens  BIGINT,
    cost_cents     NUMERIC,
    message_count  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        bucket_day,
        SUM(input_tokens)::BIGINT     AS input_tokens,
        SUM(output_tokens)::BIGINT    AS output_tokens,
        SUM(cost_cents)               AS cost_cents,
        SUM(message_count)::BIGINT    AS message_count
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;

-- ============================================================
-- Per-device cost breakdown. Powers Devices and Team pages
-- (Team groups by owner in JS using the bounded devices+users tables).
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_device(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    device_id  TEXT,
    cost_cents NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT device_id, SUM(cost_cents) AS cost_cents
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY device_id;
$$;

-- ============================================================
-- Per-(provider, model) cost breakdown.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_model(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    provider   TEXT,
    model      TEXT,
    cost_cents NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT provider, model, SUM(cost_cents) AS cost_cents
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY provider, model;
$$;

-- ============================================================
-- Per-repo cost breakdown.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_repo(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    repo_id    TEXT,
    cost_cents NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT repo_id, SUM(cost_cents) AS cost_cents
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY repo_id;
$$;

-- ============================================================
-- Per-(repo, branch) cost breakdown.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_branch(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    repo_id    TEXT,
    git_branch TEXT,
    cost_cents NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT repo_id, git_branch, SUM(cost_cents) AS cost_cents
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY repo_id, git_branch;
$$;

-- ============================================================
-- Per-ticket cost breakdown (rows with ticket IS NULL are excluded —
-- the Tickets table on /dashboard/repos has no "Unassigned" bucket).
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_ticket(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    ticket     TEXT,
    cost_cents NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT ticket, SUM(cost_cents) AS cost_cents
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND ticket IS NOT NULL
    GROUP BY ticket;
$$;
