-- Per-key / per-IP rate limiting (#179): a leaked API key, a misbehaving
-- daemon, or a compromised browser session can otherwise flood the public
-- route handlers under `src/app/api/` with no backoff signal beyond what
-- Vercel's platform default applies. Combined with the unbounded-string and
-- unvalidated-numeric issues filed in #177 / #178, this trivially fills the
-- org's `daily_rollups` and `session_summaries` tables.
--
-- Implementation: fixed-window counter, one row per (bucket_key, window_start).
-- Cheaper than a sliding-window log and more accurate than a single-counter
-- shape — at most 2× the configured limit at the window boundary, which is
-- well within the safety margin we care about for ingest abuse.
--
-- We deliberately keep this in Postgres rather than reaching for Redis: the
-- repo already depends on Supabase, the per-route call rates are well below
-- what a single connection-pooler can handle, and adding an Upstash dep
-- would mean another env var, another marketplace integration, and another
-- production failure mode for an OSS-friendly cloud whose default mode is
-- "self-host the whole stack".
--
-- ADR-0083 §7 already documents the daemon's 429 → exponential backoff
-- behavior (1s → 2s → … 5 min cap), so the daemon side is ready.

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key   TEXT        NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count        INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket_key, window_start)
);

-- Sweep stale rows ("> 1h old") with a partial index — only the recent rows
-- are ever read, but every old row would still cost on UPSERT planning.
CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx
    ON rate_limits (window_start);

-- Atomic check-and-increment. Returns the post-increment count alongside
-- the window's reset moment so callers can echo `Retry-After` headers.
--
-- Behaviour:
--   * Locates (or creates) the row for the current window.
--   * Increments the counter unconditionally, even when over the limit.
--     "Over the limit" callers being charged toward the next window is the
--     standard fixed-window behaviour and stops a hot loop from getting a
--     free pass once the counter rolls over.
--   * `allowed` is the post-increment count <= p_limit.
--
-- Window boundary:
--   floor(epoch / window_seconds) * window_seconds — deterministic and
--   shared across all callers, so two concurrent requests never land in
--   different windows by accident.
CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_bucket_key      TEXT,
    p_limit           INTEGER,
    p_window_seconds  INTEGER
)
RETURNS TABLE (
    allowed   BOOLEAN,
    remaining INTEGER,
    reset_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now           TIMESTAMPTZ := NOW();
    v_window_start  TIMESTAMPTZ;
    v_count         INTEGER;
BEGIN
    v_window_start := to_timestamp(
        floor(extract(epoch FROM v_now)::BIGINT / p_window_seconds)::BIGINT
        * p_window_seconds
    );

    INSERT INTO rate_limits (bucket_key, window_start, count)
    VALUES (p_bucket_key, v_window_start, 1)
    ON CONFLICT (bucket_key, window_start)
    DO UPDATE SET count = rate_limits.count + 1
    RETURNING count INTO v_count;

    RETURN QUERY SELECT
        v_count <= p_limit,
        GREATEST(0, p_limit - v_count),
        v_window_start + (p_window_seconds * INTERVAL '1 second');
END;
$$;

-- Garbage-collect rows older than the longest plausible window. Called
-- opportunistically from the application; not on the hot path. Returns
-- the number of rows deleted so a cron caller can log it.
CREATE OR REPLACE FUNCTION public.purge_rate_limits(p_older_than_seconds INTEGER DEFAULT 3600)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM rate_limits
    WHERE window_start < NOW() - (p_older_than_seconds * INTERVAL '1 second');
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;
