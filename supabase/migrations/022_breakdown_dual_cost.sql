-- #733: thread the dual `cost_cents_*` columns through the breakdown RPCs so
-- the Models / Repos / detail tables can render the "List: $X / Effective:
-- $Y" hover tooltip on each row. Migration 020 already extended the Overview
-- RPCs; this migration extends the rest of the dashboard's breakdown queries
-- with `cost_cents_ingested` siblings.
--
-- The existing `cost_cents` columns continue to expose the **effective** lens
-- (per the alias established in migration 019) so every consumer that doesn't
-- care about the gap keeps working unchanged. The new column is additive.
--
-- Postgres rule: `CREATE OR REPLACE FUNCTION` cannot change a `RETURNS TABLE`
-- column list, so each function is dropped and re-created. The DROP/CREATE
-- pairs stay inside this single migration so a fresh project never observes
-- an intermediate signature.

-- ============================================================
-- 1. dashboard_cost_by_model
-- ============================================================

DROP FUNCTION IF EXISTS public.dashboard_cost_by_model(TEXT[], DATE, DATE, TEXT[]);

CREATE FUNCTION public.dashboard_cost_by_model(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    provider              TEXT,
    model                 TEXT,
    cost_cents            NUMERIC,
    cost_cents_ingested   NUMERIC,
    input_tokens          BIGINT,
    output_tokens         BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        provider,
        model,
        SUM(cost_cents_effective)        AS cost_cents,
        SUM(cost_cents_ingested)         AS cost_cents_ingested,
        SUM(input_tokens)::BIGINT        AS input_tokens,
        SUM(output_tokens)::BIGINT       AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY provider, model;
$$;

-- ============================================================
-- 2. dashboard_cost_by_repo
-- ============================================================

DROP FUNCTION IF EXISTS public.dashboard_cost_by_repo(TEXT[], DATE, DATE, TEXT[]);

CREATE FUNCTION public.dashboard_cost_by_repo(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    repo_id               TEXT,
    cost_cents            NUMERIC,
    cost_cents_ingested   NUMERIC,
    input_tokens          BIGINT,
    output_tokens         BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        repo_id,
        SUM(cost_cents_effective)        AS cost_cents,
        SUM(cost_cents_ingested)         AS cost_cents_ingested,
        SUM(input_tokens)::BIGINT        AS input_tokens,
        SUM(output_tokens)::BIGINT       AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY repo_id;
$$;

-- ============================================================
-- 3. dashboard_cost_by_branch
-- ============================================================

DROP FUNCTION IF EXISTS public.dashboard_cost_by_branch(TEXT[], DATE, DATE, TEXT[]);

CREATE FUNCTION public.dashboard_cost_by_branch(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    repo_id               TEXT,
    git_branch            TEXT,
    cost_cents            NUMERIC,
    cost_cents_ingested   NUMERIC,
    input_tokens          BIGINT,
    output_tokens         BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        repo_id,
        git_branch,
        SUM(cost_cents_effective)        AS cost_cents,
        SUM(cost_cents_ingested)         AS cost_cents_ingested,
        SUM(input_tokens)::BIGINT        AS input_tokens,
        SUM(output_tokens)::BIGINT       AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY repo_id, git_branch;
$$;

-- ============================================================
-- 4. dashboard_cost_by_ticket
-- ============================================================

DROP FUNCTION IF EXISTS public.dashboard_cost_by_ticket(TEXT[], DATE, DATE, TEXT[]);

CREATE FUNCTION public.dashboard_cost_by_ticket(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    ticket                TEXT,
    cost_cents            NUMERIC,
    cost_cents_ingested   NUMERIC,
    input_tokens          BIGINT,
    output_tokens         BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        ticket,
        SUM(cost_cents_effective)        AS cost_cents,
        SUM(cost_cents_ingested)         AS cost_cents_ingested,
        SUM(input_tokens)::BIGINT        AS input_tokens,
        SUM(output_tokens)::BIGINT       AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND ticket IS NOT NULL
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY ticket;
$$;
