-- Day-of-week × hour-of-day activity heatmap for the Overview page (#150).
--
-- Counts sessions whose `started_at` falls inside the viewer's local-TZ
-- window, bucketed by `(dow, hour)` interpreted in the **viewer's IANA
-- timezone**. The heatmap answers "when does this team actually work" — a
-- US/Pacific viewer needs to see "5pm peak" at column 17, not at column 0
-- where the UTC clock would put the same instant.
--
-- The grid is fixed-size (7 × 24); empty cells just don't appear in the
-- result and the client fills them with zero, so we don't need a generate-
-- series cross join here. Using `started_at` (not the rollup `bucket_day`)
-- is intentional — only `session_summaries` carries the wall-clock instant
-- needed to derive an hour-of-day. Sessions with NULL `started_at` are
-- excluded, which matches what the Sessions page can render (#84) and
-- keeps the heatmap source consistent with what users see when they drill
-- in.
--
-- Postgres returns `dow` as `0=Sunday..6=Saturday` (per ISO/SQL spec); the
-- client decides the visual ordering. The visibility scope is enforced
-- upstream by `getVisibleDeviceIds`; `p_device_ids` is the authoritative
-- gate, same pattern as every other `dashboard_*` RPC since #92.
CREATE OR REPLACE FUNCTION public.dashboard_activity_heatmap(
    p_device_ids     TEXT[],
    p_started_from   TIMESTAMPTZ,
    p_started_to     TIMESTAMPTZ,
    p_time_zone      TEXT
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
    GROUP BY 1, 2
    ORDER BY 1, 2;
$$;
