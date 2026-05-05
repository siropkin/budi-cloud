-- Per-day active-member count and cost for the Team page (#127).
--
-- Active members per day = COUNT DISTINCT users whose devices wrote any
-- rollup row for that bucket. Cost is the same `SUM(cost_cents)` aggregation
-- the other dashboard breakdowns use, surfaced alongside the count so the
-- "cost per person" chart can divide the two without a second round trip.
--
-- Joining `daily_rollups` to `devices` happens in Postgres for the same
-- reason the other `dashboard_*` RPCs aggregate server-side: PostgREST's
-- 1,000-row default cap turns every JS-side join into a silent truncation
-- bomb once an org grows past it (see #92, the rationale captured in
-- `004_dashboard_aggregates.sql`). The viewer's visibility scope is still
-- enforced by `getVisibleDeviceIds` upstream — `p_device_ids` is the
-- authoritative gate.
CREATE OR REPLACE FUNCTION public.dashboard_team_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
)
RETURNS TABLE (
    bucket_day      DATE,
    active_members  BIGINT,
    cost_cents      NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        r.bucket_day,
        COUNT(DISTINCT d.user_id)::BIGINT AS active_members,
        SUM(r.cost_cents)                 AS cost_cents
    FROM daily_rollups r
    JOIN devices d ON d.id = r.device_id
    WHERE r.device_id = ANY(p_device_ids)
      AND r.bucket_day BETWEEN p_bucket_from AND p_bucket_to
    GROUP BY r.bucket_day
    ORDER BY r.bucket_day ASC;
$$;
