-- Per-day active-device count and cost for the Devices page (#145).
--
-- Mirrors `dashboard_team_activity_by_day` but pivots on `device_id` instead
-- of `user_id` so the Devices page can show "active devices per day" and a
-- "cost per device" time series alongside the existing per-device bar chart.
-- The viewer's visibility scope is enforced upstream via `getVisibleDeviceIds`
-- — `p_device_ids` is the authoritative gate. Aggregating in Postgres keeps
-- us safe from PostgREST's 1k-row default cap (see #92, #008).
CREATE OR REPLACE FUNCTION public.dashboard_device_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
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
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;
