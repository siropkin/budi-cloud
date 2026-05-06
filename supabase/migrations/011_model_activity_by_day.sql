-- Per-day active-model count and cost for the Models page (#147).
--
-- Mirrors `dashboard_device_activity_by_day` (#145) but pivots on the
-- `(provider, model)` pair instead of `device_id` so the Models page can show
-- "active models per day" and a "cost per model" time series alongside the
-- existing per-model bar chart. `gpt-4o` on OpenAI and `gpt-4o` on Azure are
-- distinct lines on the bar chart, so they should also count as distinct lines
-- in the active-model headcount — we group on the pair, not just the model
-- string.
--
-- The viewer's visibility scope is enforced upstream via `getVisibleDeviceIds`
-- — `p_device_ids` is the authoritative gate. Aggregating in Postgres keeps
-- us safe from PostgREST's 1k-row default cap (see #92, #008).
CREATE OR REPLACE FUNCTION public.dashboard_model_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE
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
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;
