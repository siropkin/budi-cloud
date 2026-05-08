-- Plumb the new `surface` dimension (#187, migration 014) through every
-- dashboard breakdown RPC, plus add two new RPCs the surface UI needs:
--
--   * `dashboard_cost_by_surface`   — powers the "Spend by Surface" card on
--     the Overview page.
--   * `dashboard_known_surfaces`    — populates the `<SurfaceFilter>` chip's
--     options from the data, not a hardcoded enum, so the day a JetBrains
--     daemon first syncs the org's filter chip picks it up automatically.
--
-- Filter contract: every RPC takes a new `p_surfaces TEXT[]` parameter. NULL
-- means "no filter" (existing behaviour); a non-NULL array narrows aggregation
-- to the listed surfaces. We deliberately treat the empty array the same as
-- NULL so a chip whose user deselected every option doesn't "filter to no
-- surfaces and zero everything out" — that state is logically equivalent to
-- the all-surfaces default.
--
-- Postgres rule: `CREATE OR REPLACE FUNCTION` cannot change a function's
-- argument list (signature is part of identity), so we DROP the old shape
-- first. The next CREATE re-establishes each RPC with the wider signature.

DROP FUNCTION IF EXISTS public.dashboard_overview_stats(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_daily_activity(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_device(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_model(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_repo(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_branch(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_cost_by_ticket(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_team_activity_by_day(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_device_activity_by_day(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_model_activity_by_day(TEXT[], DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_activity_heatmap(TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT);

-- ============================================================
-- Overview totals
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_overview_stats(
    p_device_ids   TEXT[],
    p_bucket_from  DATE,
    p_bucket_to    DATE,
    p_surfaces     TEXT[] DEFAULT NULL
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
          AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
               OR surface = ANY(p_surfaces))
    ),
    s AS (
        SELECT COUNT(*)::BIGINT AS total_sessions
        FROM session_summaries
        WHERE device_id = ANY(p_device_ids)
          AND COALESCE(started_at, ended_at, synced_at)::date
              BETWEEN p_bucket_from AND p_bucket_to
          AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
               OR surface = ANY(p_surfaces))
    )
    SELECT r.total_cost_cents, r.total_input_tokens, r.total_output_tokens,
           r.total_messages, s.total_sessions
    FROM r, s;
$$;

-- ============================================================
-- Daily activity series
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_daily_activity(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;

-- ============================================================
-- Per-device breakdown (Devices, Team-by-user via JS join)
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_device(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY device_id;
$$;

-- ============================================================
-- Per-(provider, model) breakdown
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_model(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY provider, model;
$$;

-- ============================================================
-- Per-repo breakdown
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_repo(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY repo_id;
$$;

-- ============================================================
-- Per-(repo, branch) breakdown
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_branch(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY repo_id, git_branch;
$$;

-- ============================================================
-- Per-ticket breakdown (rows with ticket IS NULL still excluded)
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_ticket(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY ticket;
$$;

-- ============================================================
-- Team activity per day (#127)
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_team_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR r.surface = ANY(p_surfaces))
    GROUP BY r.bucket_day
    ORDER BY r.bucket_day ASC;
$$;

-- ============================================================
-- Device activity per day (#145)
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_device_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    bucket_day      DATE,
    active_devices  BIGINT,
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
        bucket_day,
        COUNT(DISTINCT device_id)::BIGINT AS active_devices,
        SUM(cost_cents)                   AS cost_cents,
        SUM(input_tokens)::BIGINT         AS input_tokens,
        SUM(output_tokens)::BIGINT        AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;

-- ============================================================
-- Model activity per day (#147)
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_model_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    bucket_day     DATE,
    active_models  BIGINT,
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
        bucket_day,
        COUNT(DISTINCT (provider, model))::BIGINT AS active_models,
        SUM(cost_cents)                            AS cost_cents,
        SUM(input_tokens)::BIGINT                  AS input_tokens,
        SUM(output_tokens)::BIGINT                 AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;

-- ============================================================
-- Activity heatmap (#150)
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_activity_heatmap(
    p_device_ids     TEXT[],
    p_started_from   TIMESTAMPTZ,
    p_started_to     TIMESTAMPTZ,
    p_time_zone      TEXT,
    p_surfaces       TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    dow            INT,
    hour           INT,
    session_count  BIGINT,
    cost_cents     NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        EXTRACT(DOW  FROM started_at AT TIME ZONE p_time_zone)::INT  AS dow,
        EXTRACT(HOUR FROM started_at AT TIME ZONE p_time_zone)::INT  AS hour,
        COUNT(*)::BIGINT                                              AS session_count,
        COALESCE(SUM(total_cost_cents), 0)                            AS cost_cents
    FROM session_summaries
    WHERE device_id = ANY(p_device_ids)
      AND started_at IS NOT NULL
      AND started_at >= p_started_from
      AND started_at <= p_started_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY 1, 2
    ORDER BY 1, 2;
$$;

-- ============================================================
-- New: cost share by surface (#187 part 2 — "Spend by Surface" card)
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_cost_by_surface(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    surface        TEXT,
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
        surface,
        SUM(cost_cents)              AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY surface;
$$;

-- ============================================================
-- New: distinct surfaces present in the org's data (#187 part 1 —
-- populates the `<SurfaceFilter>` chip's options without a hardcoded enum).
-- We deliberately do NOT range-filter the lookup: if a surface ever appeared
-- for this org we want to keep it in the chip even when the current period
-- has no rows for it, so the "Filter to JetBrains" history still works after
-- the team migrates off it.
-- ============================================================
CREATE OR REPLACE FUNCTION public.dashboard_known_surfaces(
    p_device_ids  TEXT[]
)
RETURNS TABLE (
    surface  TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT DISTINCT surface
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
    ORDER BY surface ASC;
$$;
