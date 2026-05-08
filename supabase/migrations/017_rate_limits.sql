-- #179: Postgres-backed fixed-window rate limiter for the public API routes
-- (`/v1/ingest`, `/v1/ingest/status`, `/v1/whoami`, `/api/freshness`). The
-- counter lives in Postgres rather than Redis so the cloud doesn't grow a new
-- runtime dependency just for this — see issue #179 for the trade-off
-- discussion. ADR-0083 §7 already specs daemon backoff on 429, so the daemon
-- side handles the response gracefully.
--
-- The RPC is wrapped in a single UPSERT so the read-and-increment is atomic
-- across the Vercel Fluid Compute fleet — no per-instance drift.
--
-- Stale rows (one per unique bucket id seen in the last window) are not
-- explicitly pruned: at the volumes this dashboard sees, a few thousand rows
-- worth of bookkeeping is cheaper than running a cron. If the table grows
-- past expectations, add a daily `DELETE FROM rate_limits WHERE
-- window_start < NOW() - INTERVAL '1 day'` job.

CREATE TABLE rate_limits (
    bucket          TEXT        PRIMARY KEY,
    window_start    TIMESTAMPTZ NOT NULL,
    count           INTEGER     NOT NULL
);

-- Restrict direct table access to the service-role admin client. Anon and
-- authenticated PostgREST roles must never read or mutate this table; the
-- only sanctioned mutation path is `rate_limit_check` below.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION rate_limit_check(
    p_bucket            TEXT,
    p_limit             INTEGER,
    p_window_seconds    INTEGER
)
RETURNS TABLE(
    allowed                 BOOLEAN,
    current_count           INTEGER,
    retry_after_seconds     INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now           TIMESTAMPTZ := NOW();
    v_count         INTEGER;
    v_window_start  TIMESTAMPTZ;
    v_window_end    TIMESTAMPTZ;
BEGIN
    -- Fixed-window counter: when the prior window has elapsed, reset to 1;
    -- otherwise increment in place. Doing both branches in a single UPSERT
    -- keeps it atomic — two concurrent calls for the same bucket cannot
    -- both observe `count = limit` and both pass.
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (p_bucket, v_now, 1)
    ON CONFLICT (bucket) DO UPDATE
        SET count = CASE
                WHEN rate_limits.window_start + (p_window_seconds || ' seconds')::INTERVAL < v_now
                    THEN 1
                ELSE rate_limits.count + 1
            END,
            window_start = CASE
                WHEN rate_limits.window_start + (p_window_seconds || ' seconds')::INTERVAL < v_now
                    THEN v_now
                ELSE rate_limits.window_start
            END
    RETURNING rate_limits.count, rate_limits.window_start
        INTO v_count, v_window_start;

    v_window_end := v_window_start + (p_window_seconds || ' seconds')::INTERVAL;

    allowed := v_count <= p_limit;
    current_count := v_count;
    retry_after_seconds := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_window_end - v_now)))::INTEGER);
    RETURN NEXT;
END;
$$;

-- Only the service role calls the RPC (admin client). Lock everyone else out.
REVOKE ALL ON FUNCTION rate_limit_check(TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_check(TEXT, INTEGER, INTEGER) TO service_role;
