-- Surface input_tokens / output_tokens on every breakdown RPC so the dashboard
-- unit toggle (#128) can render the same chart in dollars or tokens without a
-- second round trip. Cost was the only metric the breakdown RPCs emitted —
-- adding tokens here keeps the per-row aggregation in Postgres so the
-- 100k-row cap that #92 fixed cannot resurface as a JS-side sum.
--
-- Postgres won't let `CREATE OR REPLACE FUNCTION` change a function's
-- RETURNS TABLE shape (it's the same row-type rule that blocks dropping a
-- column from a view). Drop each function first; the next CREATE
-- re-establishes it with the wider tuple.

DROP FUNCTION IF EXISTS public.dashboard_cost_by_device(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_model(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_repo(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_branch(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_ticket(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_team_activity_by_day(TEXT[], DATE, DATE);

-- ============================================================
-- Per-device breakdown (Devices, Team-by-user via JS join).
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_device(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    device_id      TEXT,
    cost_cents     NUMERIC,
    input_tokens   BIGINT,
    output_tokens  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        device_id,
        SUM(cost_cents)              AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY device_id;
$$;

-- ============================================================
-- Per-(provider, model) breakdown.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_model(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    provider       TEXT,
    model          TEXT,
    cost_cents     NUMERIC,
    input_tokens   BIGINT,
    output_tokens  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        provider,
        model,
        SUM(cost_cents)              AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY provider, model;
$$;

-- ============================================================
-- Per-repo breakdown.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_repo(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    repo_id        TEXT,
    cost_cents     NUMERIC,
    input_tokens   BIGINT,
    output_tokens  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        repo_id,
        SUM(cost_cents)              AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY repo_id;
$$;

-- ============================================================
-- Per-(repo, branch) breakdown.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_branch(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    repo_id        TEXT,
    git_branch     TEXT,
    cost_cents     NUMERIC,
    input_tokens   BIGINT,
    output_tokens  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        repo_id,
        git_branch,
        SUM(cost_cents)              AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY repo_id, git_branch;
$$;

-- ============================================================
-- Per-ticket breakdown (rows with ticket IS NULL still excluded).
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_ticket(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    ticket         TEXT,
    cost_cents     NUMERIC,
    input_tokens   BIGINT,
    output_tokens  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        ticket,
        SUM(cost_cents)              AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND ticket IS NOT NULL
    GROUP BY ticket;
$$;

-- ============================================================
-- Team activity per day — adds tokens alongside the existing cost.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_team_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    bucket_day      DATE,
    active_members  BIGINT,
    cost_cents      NUMERIC,
    input_tokens    BIGINT,
    output_tokens   BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        r.bucket_day,
        COUNT(DISTINCT d.user_id)::BIGINT AS active_members,
        SUM(r.cost_cents)                 AS cost_cents,
        SUM(r.input_tokens)::BIGINT       AS input_tokens,
        SUM(r.output_tokens)::BIGINT      AS output_tokens
    FROM daily_rollups r
    JOIN devices d ON d.id = r.device_id
    WHERE r.device_id = ANY(p_device_ids)
      AND r.bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY r.bucket_day
    ORDER BY r.bucket_day ASC;
$$;
