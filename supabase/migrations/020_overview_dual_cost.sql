-- #235: surface the dual `cost_cents_*` columns from the two Overview RPCs.
-- Migration 019 added the columns + aliased `cost_cents_effective AS cost_cents`
-- so existing dashboard code kept rendering unchanged. The savings strip and
-- the Effective/List view toggle on /dashboard need both values in a single
-- payload, so we extend the RPC return shapes with `_ingested` siblings.
--
-- The existing `cost_cents` aliases stay so other readers (every other RPC,
-- every breakdown table) remain on the effective lens — they don't care about
-- the gap. Only the Overview surfaces the delta in v1.
--
-- Postgres rule: changing a `RETURNS TABLE` column list is *not* compatible
-- with `CREATE OR REPLACE FUNCTION` — we have to drop and recreate. Each
-- DROP/CREATE pair is inside the same migration so a fresh project never
-- observes an intermediate state.

-- ============================================================
-- 1. dashboard_overview_stats: add `total_cost_cents_ingested`
-- ============================================================

DROP FUNCTION IF EXISTS public.dashboard_overview_stats(TEXT[], DATE, DATE, TEXT[]);

CREATE FUNCTION public.dashboard_overview_stats(
    p_device_ids   TEXT[],
    p_bucket_from  DATE,
    p_bucket_to    DATE,
    p_surfaces     TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    total_cost_cents            NUMERIC,
    total_cost_cents_ingested   NUMERIC,
    total_input_tokens          BIGINT,
    total_output_tokens         BIGINT,
    total_messages              BIGINT,
    total_sessions              BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH r AS (
        SELECT
            COALESCE(SUM(cost_cents_effective), 0)   AS total_cost_cents,
            COALESCE(SUM(cost_cents_ingested), 0)    AS total_cost_cents_ingested,
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
    SELECT r.total_cost_cents, r.total_cost_cents_ingested,
           r.total_input_tokens, r.total_output_tokens,
           r.total_messages, s.total_sessions
    FROM r, s;
$$;

-- ============================================================
-- 2. dashboard_daily_activity: add `cost_cents_ingested`
-- ============================================================

DROP FUNCTION IF EXISTS public.dashboard_daily_activity(TEXT[], DATE, DATE, TEXT[]);

CREATE FUNCTION public.dashboard_daily_activity(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    bucket_day            DATE,
    input_tokens          BIGINT,
    output_tokens         BIGINT,
    cost_cents            NUMERIC,
    cost_cents_ingested   NUMERIC,
    message_count         BIGINT
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
        SUM(cost_cents_effective)     AS cost_cents,
        SUM(cost_cents_ingested)      AS cost_cents_ingested,
        SUM(message_count)::BIGINT    AS message_count
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;
