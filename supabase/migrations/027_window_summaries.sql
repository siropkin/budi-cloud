-- #339: Rate-limit window summaries — ingest, storage, and dashboard RPCs
--
-- The budi daemon (v8.5.4+) computes 5-hour rate-limit windows on-the-fly
-- from messages and the `rate_limit_resets` table. This migration adds the
-- cloud-side table to receive pre-aggregated, privacy-safe window summaries
-- via the sync envelope (approach B from the issue), plus the RPCs the
-- dashboard needs for per-window, throttle-event, and burn-rate charts.

CREATE TABLE public.window_summaries (
  device_id       UUID           NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ    NOT NULL,
  ended_at        TIMESTAMPTZ    NOT NULL,
  duration_minutes DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_active       BOOLEAN        NOT NULL DEFAULT FALSE,
  message_count   BIGINT         NOT NULL DEFAULT 0,
  input_tokens    BIGINT         NOT NULL DEFAULT 0,
  output_tokens   BIGINT         NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT   NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT   NOT NULL DEFAULT 0,
  cost_cents      NUMERIC(12,4)  NOT NULL DEFAULT 0,
  burn_rate_cents_per_minute DOUBLE PRECISION NOT NULL DEFAULT 0,
  hit_rate_limit  BOOLEAN        NOT NULL DEFAULT FALSE,
  provider        TEXT           NOT NULL DEFAULT 'unknown',
  surface         TEXT           NOT NULL DEFAULT 'unknown',
  synced_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),

  PRIMARY KEY (device_id, started_at)
);

-- #306: explicit GRANTs for forward compatibility with Supabase's upcoming
-- Data API default change (2026-10-30).
GRANT SELECT ON public.window_summaries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.window_summaries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.window_summaries TO service_role;

ALTER TABLE public.window_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role has full access to window_summaries"
  ON public.window_summaries
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for time-range scans (the dashboard always filters by device_id + time).
CREATE INDEX idx_window_summaries_started_at
  ON window_summaries (started_at);

-- Index for throttle-event queries (Phase 2/3: "who hit their rate limit?").
CREATE INDEX idx_window_summaries_hit_rate_limit
  ON window_summaries (hit_rate_limit)
  WHERE hit_rate_limit = TRUE;

-- ---------------------------------------------------------------------------
-- Dashboard RPCs
-- ---------------------------------------------------------------------------

-- Window usage timeline: tokens/cost per calendar day, aggregated from windows.
CREATE OR REPLACE FUNCTION dashboard_window_timeline(
  p_device_ids UUID[],
  p_started_from TIMESTAMPTZ,
  p_started_to   TIMESTAMPTZ,
  p_surfaces     TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  bucket_day       DATE,
  window_count     BIGINT,
  message_count    BIGINT,
  input_tokens     BIGINT,
  output_tokens    BIGINT,
  cost_cents       NUMERIC,
  avg_burn_rate    DOUBLE PRECISION
) LANGUAGE sql STABLE AS $$
  SELECT
    (w.started_at AT TIME ZONE 'UTC')::DATE AS bucket_day,
    COUNT(*)                                AS window_count,
    SUM(w.message_count)                    AS message_count,
    SUM(w.input_tokens)                     AS input_tokens,
    SUM(w.output_tokens)                    AS output_tokens,
    SUM(w.cost_cents)                       AS cost_cents,
    AVG(w.burn_rate_cents_per_minute)        AS avg_burn_rate
  FROM window_summaries w
  WHERE w.device_id = ANY(p_device_ids)
    AND w.started_at >= p_started_from
    AND w.started_at <= p_started_to
    AND (p_surfaces IS NULL OR w.surface = ANY(p_surfaces))
  GROUP BY 1
  ORDER BY 1;
$$;

-- Throttle events: windows where the user hit the rate limit.
CREATE OR REPLACE FUNCTION dashboard_throttle_events(
  p_device_ids UUID[],
  p_started_from TIMESTAMPTZ,
  p_started_to   TIMESTAMPTZ,
  p_surfaces     TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  duration_minutes DOUBLE PRECISION,
  message_count    BIGINT,
  input_tokens     BIGINT,
  output_tokens    BIGINT,
  cost_cents       NUMERIC,
  burn_rate        DOUBLE PRECISION,
  device_id        UUID,
  provider         TEXT,
  surface          TEXT
) LANGUAGE sql STABLE AS $$
  SELECT
    w.started_at,
    w.ended_at,
    w.duration_minutes,
    w.message_count,
    w.input_tokens,
    w.output_tokens,
    w.cost_cents,
    w.burn_rate_cents_per_minute AS burn_rate,
    w.device_id,
    w.provider,
    w.surface
  FROM window_summaries w
  WHERE w.device_id = ANY(p_device_ids)
    AND w.started_at >= p_started_from
    AND w.started_at <= p_started_to
    AND w.hit_rate_limit = TRUE
    AND (p_surfaces IS NULL OR w.surface = ANY(p_surfaces))
  ORDER BY w.started_at DESC;
$$;

-- Burn rate trend: per-window burn rate ordered by time.
CREATE OR REPLACE FUNCTION dashboard_burn_rate_trend(
  p_device_ids UUID[],
  p_started_from TIMESTAMPTZ,
  p_started_to   TIMESTAMPTZ,
  p_surfaces     TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  started_at  TIMESTAMPTZ,
  burn_rate   DOUBLE PRECISION,
  cost_cents  NUMERIC,
  device_id   UUID
) LANGUAGE sql STABLE AS $$
  SELECT
    w.started_at,
    w.burn_rate_cents_per_minute AS burn_rate,
    w.cost_cents,
    w.device_id
  FROM window_summaries w
  WHERE w.device_id = ANY(p_device_ids)
    AND w.started_at >= p_started_from
    AND w.started_at <= p_started_to
    AND (p_surfaces IS NULL OR w.surface = ANY(p_surfaces))
  ORDER BY w.started_at;
$$;

-- Team rate-limit stats: count of distinct users who hit rate limits per day.
CREATE OR REPLACE FUNCTION dashboard_team_rate_limit_stats(
  p_device_ids UUID[],
  p_started_from TIMESTAMPTZ,
  p_started_to   TIMESTAMPTZ,
  p_surfaces     TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  bucket_day              DATE,
  users_hitting_limit     BIGINT,
  total_throttle_windows  BIGINT,
  total_windows           BIGINT
) LANGUAGE sql STABLE AS $$
  SELECT
    (w.started_at AT TIME ZONE 'UTC')::DATE AS bucket_day,
    COUNT(DISTINCT d.user_id) FILTER (WHERE w.hit_rate_limit = TRUE) AS users_hitting_limit,
    COUNT(*) FILTER (WHERE w.hit_rate_limit = TRUE)                  AS total_throttle_windows,
    COUNT(*)                                                          AS total_windows
  FROM window_summaries w
  JOIN devices d ON d.id = w.device_id
  WHERE w.device_id = ANY(p_device_ids)
    AND w.started_at >= p_started_from
    AND w.started_at <= p_started_to
    AND (p_surfaces IS NULL OR w.surface = ANY(p_surfaces))
  GROUP BY 1
  ORDER BY 1;
$$;
