-- #233: Recalculation engine — recompute `cost_cents_effective` from a team's
-- active price list(s). Implements the math layer of ADR-0094 §7.
--
-- Inputs: org_id, date window. The function:
--   1. Inserts a `recalculation_runs` row in `running` and captures the
--      pre-recalc `cost_cents_effective` total for the scope.
--   2. For every (daily_rollups row, token_type) in scope, picks the
--      most-specific matching price-list row from the org's active lists
--      (most-specific = exact model match beats alias; region-pinned beats
--      region-agnostic). Same resolution applies to `session_summaries`.
--   3. Recomputes `cost_cents_effective` =
--        (input × in_rate + output × out_rate +
--         cache_creation × cache_write_rate + cache_read × cache_read_rate)
--        / 10_000     (tokens × USD/MTok → cents)
--      If *no* price-list row matches a rollup's (provider, model, region,
--      bucket_day) combination, the row falls through to
--      `cost_cents_ingested` (the LiteLLM-priced number the daemon already
--      shipped). That is what makes the rollback path work: archive every
--      list → no matches → effective reverts to ingested.
--   4. Captures the post-recalc total, closes the `recalculation_runs` row
--      with status `succeeded` and a `rows_changed` count. The whole thing
--      is one transaction (it's a single function call), so a mid-run
--      failure rolls everything back including the audit row.
--
-- Idempotency: the UPDATE skips rows whose `cost_cents_effective` already
-- equals the freshly-computed value, so a second run over the same window
-- with the same active lists records `rows_changed = 0` (acceptance #2).

-- ============================================================
-- 1. Return type
-- ============================================================

DROP TYPE IF EXISTS recalc_summary CASCADE;

CREATE TYPE recalc_summary AS (
    run_id              BIGINT,
    rows_processed      BIGINT,
    rows_changed        BIGINT,
    before_total_cents  NUMERIC,
    after_total_cents   NUMERIC
);

-- ============================================================
-- 2. recalculate_effective_cost
-- ============================================================

CREATE OR REPLACE FUNCTION public.recalculate_effective_cost(
    p_org_id        TEXT,
    p_from_date     DATE,
    p_to_date       DATE,
    p_triggered_by  TEXT DEFAULT NULL
)
RETURNS recalc_summary
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run_id              BIGINT;
    v_before_rollups      NUMERIC;
    v_before_sessions     NUMERIC;
    v_after_rollups       NUMERIC;
    v_after_sessions      NUMERIC;
    v_rows_processed      BIGINT := 0;
    v_rows_changed        BIGINT := 0;
    v_active_list_ids     BIGINT[];
    v_result              recalc_summary;
BEGIN
    IF p_from_date IS NULL OR p_to_date IS NULL OR p_from_date > p_to_date THEN
        RAISE EXCEPTION 'recalculate_effective_cost: invalid date window [% .. %]',
            p_from_date, p_to_date;
    END IF;

    -- Lists driving this run (snapshotted into the audit row so future
    -- archival of a list doesn't lose the "which list was active here?" link).
    SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::BIGINT[])
      INTO v_active_list_ids
      FROM org_price_lists
     WHERE org_id = p_org_id
       AND status = 'active'
       AND effective_from <= p_to_date
       AND (effective_to IS NULL OR effective_to >= p_from_date);

    -- Pre-recalc totals across both surfaces of `_effective`. Sessions are
    -- bucketed by COALESCE(started_at, ended_at, synced_at) to match the
    -- convention every dashboard RPC uses.
    SELECT COALESCE(SUM(r.cost_cents_effective), 0)
      INTO v_before_rollups
      FROM daily_rollups r
      JOIN devices d ON d.id = r.device_id
      JOIN users   u ON u.id = d.user_id
     WHERE u.org_id = p_org_id
       AND r.bucket_day BETWEEN p_from_date AND p_to_date;

    SELECT COALESCE(SUM(s.total_cost_cents_effective), 0)
      INTO v_before_sessions
      FROM session_summaries s
      JOIN devices d ON d.id = s.device_id
      JOIN users   u ON u.id = d.user_id
     WHERE u.org_id = p_org_id
       AND COALESCE(s.started_at, s.ended_at, s.synced_at)::date
             BETWEEN p_from_date AND p_to_date;

    INSERT INTO recalculation_runs (
        org_id, status, scope_from_date, scope_to_date,
        price_list_ids, before_total_cents, triggered_by
    ) VALUES (
        p_org_id, 'running', p_from_date, p_to_date,
        v_active_list_ids, v_before_rollups + v_before_sessions, p_triggered_by
    )
    RETURNING id INTO v_run_id;

    -- --------------------------------------------------------
    -- 2a. daily_rollups: per-row, per-token-type rate resolution
    -- --------------------------------------------------------
    -- The CTE pipeline:
    --   scope     → daily_rollups in this org × this date window
    --   matches   → every active-list row that *could* apply, joined to
    --               alias rows so the daemon's wire model names match the
    --               canonical CSV `model_pattern`
    --   ranked    → pick the most-specific row per (rollup, token_type):
    --               region-pinned wins over region-agnostic; exact model
    --               match wins over alias match; deterministic tiebreak
    --               on price_list_rows.id
    --   pivoted   → 4-rate row per rollup, one column per token_type
    --   new_costs → final new effective cost, with fall-through to
    --               `cost_cents_ingested` when *no* token_type matched
    WITH defaults AS (
        SELECT default_platform, default_region
          FROM org_pricing_defaults
         WHERE org_id = p_org_id
    ),
    scope AS (
        SELECT r.*
          FROM daily_rollups r
          JOIN devices d ON d.id = r.device_id
          JOIN users   u ON u.id = d.user_id
         WHERE u.org_id = p_org_id
           AND r.bucket_day BETWEEN p_from_date AND p_to_date
    ),
    matches AS (
        SELECT
            s.device_id, s.bucket_day, s.role, s.provider, s.model,
            s.repo_id, s.git_branch, s.surface,
            plr.token_type,
            plr.sale_usd_per_mtok,
            plr.region,
            plr.model_pattern,
            plr.id AS price_row_id,
            (plr.model_pattern = s.model) AS exact_model
          FROM scope s
          JOIN org_price_lists al
            ON al.org_id = p_org_id
           AND al.status = 'active'
           AND s.bucket_day
               BETWEEN al.effective_from
                   AND COALESCE(al.effective_to, 'infinity'::date)
          JOIN org_price_list_rows plr ON plr.list_id = al.id
          LEFT JOIN model_aliases ma ON ma.display_name = plr.model_pattern
          LEFT JOIN defaults def ON TRUE
         WHERE plr.platform = s.provider
           AND (plr.region IS NULL
                OR def.default_region IS NULL
                OR plr.region = def.default_region)
           AND (plr.model_pattern = s.model
                OR (ma.display_name IS NOT NULL AND s.model = ANY(ma.patterns)))
    ),
    ranked AS (
        SELECT *,
            ROW_NUMBER() OVER (
                PARTITION BY device_id, bucket_day, role, provider, model,
                             repo_id, git_branch, surface, token_type
                ORDER BY
                    (region IS NOT NULL) DESC,   -- region-pinned beats agnostic
                    exact_model DESC,             -- exact > alias
                    price_row_id                  -- deterministic tiebreak
            ) AS rn
          FROM matches
    ),
    best AS (
        SELECT device_id, bucket_day, role, provider, model,
               repo_id, git_branch, surface,
               token_type, sale_usd_per_mtok
          FROM ranked
         WHERE rn = 1
    ),
    pivoted AS (
        SELECT
            device_id, bucket_day, role, provider, model,
            repo_id, git_branch, surface,
            MAX(CASE WHEN token_type = 'input'       THEN sale_usd_per_mtok END) AS r_input,
            MAX(CASE WHEN token_type = 'output'      THEN sale_usd_per_mtok END) AS r_output,
            MAX(CASE WHEN token_type = 'cache_write' THEN sale_usd_per_mtok END) AS r_cwrite,
            MAX(CASE WHEN token_type = 'cache_read'  THEN sale_usd_per_mtok END) AS r_cread
          FROM best
         GROUP BY device_id, bucket_day, role, provider, model,
                  repo_id, git_branch, surface
    ),
    new_costs AS (
        SELECT
            s.device_id, s.bucket_day, s.role, s.provider, s.model,
            s.repo_id, s.git_branch, s.surface,
            s.cost_cents_effective AS old_cost,
            CASE
                WHEN p.device_id IS NULL THEN s.cost_cents_ingested
                ELSE (
                    s.input_tokens          * COALESCE(p.r_input,  0)
                  + s.output_tokens         * COALESCE(p.r_output, 0)
                  + s.cache_creation_tokens * COALESCE(p.r_cwrite, 0)
                  + s.cache_read_tokens     * COALESCE(p.r_cread,  0)
                ) / 10000.0
            END AS new_cost
          FROM scope s
          LEFT JOIN pivoted p USING (
              device_id, bucket_day, role, provider, model,
              repo_id, git_branch, surface
          )
    ),
    upd AS (
        UPDATE daily_rollups dr
           SET cost_cents_effective = nc.new_cost
          FROM new_costs nc
         WHERE dr.device_id  = nc.device_id
           AND dr.bucket_day = nc.bucket_day
           AND dr.role       = nc.role
           AND dr.provider   = nc.provider
           AND dr.model      = nc.model
           AND dr.repo_id    = nc.repo_id
           AND dr.git_branch = nc.git_branch
           AND dr.surface    = nc.surface
           AND dr.cost_cents_effective IS DISTINCT FROM nc.new_cost
         RETURNING 1
    ),
    proc AS (SELECT COUNT(*) AS c FROM new_costs)
    SELECT proc.c, (SELECT COUNT(*) FROM upd)
      INTO v_rows_processed, v_rows_changed
      FROM proc;

    -- --------------------------------------------------------
    -- 2b. session_summaries: only input + output. Sessions don't carry
    --     cache-token splits in v1, so the cache rates don't apply here.
    --     Sessions without a `main_model` fall through to ingested.
    -- --------------------------------------------------------
    WITH defaults AS (
        SELECT default_platform, default_region
          FROM org_pricing_defaults
         WHERE org_id = p_org_id
    ),
    scope AS (
        SELECT s.*,
               COALESCE(s.started_at, s.ended_at, s.synced_at)::date AS bucket_day
          FROM session_summaries s
          JOIN devices d ON d.id = s.device_id
          JOIN users   u ON u.id = d.user_id
         WHERE u.org_id = p_org_id
           AND COALESCE(s.started_at, s.ended_at, s.synced_at)::date
                 BETWEEN p_from_date AND p_to_date
    ),
    matches AS (
        SELECT
            s.device_id, s.session_id,
            plr.token_type, plr.sale_usd_per_mtok,
            plr.region, plr.model_pattern, plr.id AS price_row_id,
            (plr.model_pattern = s.main_model) AS exact_model
          FROM scope s
          JOIN org_price_lists al
            ON al.org_id = p_org_id
           AND al.status = 'active'
           AND s.bucket_day
               BETWEEN al.effective_from
                   AND COALESCE(al.effective_to, 'infinity'::date)
          JOIN org_price_list_rows plr ON plr.list_id = al.id
          LEFT JOIN model_aliases ma ON ma.display_name = plr.model_pattern
          LEFT JOIN defaults def ON TRUE
         WHERE s.main_model IS NOT NULL
           AND plr.platform = s.provider
           AND plr.token_type IN ('input', 'output')
           AND (plr.region IS NULL
                OR def.default_region IS NULL
                OR plr.region = def.default_region)
           AND (plr.model_pattern = s.main_model
                OR (ma.display_name IS NOT NULL
                    AND s.main_model = ANY(ma.patterns)))
    ),
    ranked AS (
        SELECT *,
            ROW_NUMBER() OVER (
                PARTITION BY device_id, session_id, token_type
                ORDER BY
                    (region IS NOT NULL) DESC,
                    exact_model DESC,
                    price_row_id
            ) AS rn
          FROM matches
    ),
    best AS (
        SELECT device_id, session_id, token_type, sale_usd_per_mtok
          FROM ranked WHERE rn = 1
    ),
    pivoted AS (
        SELECT
            device_id, session_id,
            MAX(CASE WHEN token_type = 'input'  THEN sale_usd_per_mtok END) AS r_input,
            MAX(CASE WHEN token_type = 'output' THEN sale_usd_per_mtok END) AS r_output
          FROM best
         GROUP BY device_id, session_id
    ),
    new_costs AS (
        SELECT
            s.device_id, s.session_id,
            CASE
                WHEN p.device_id IS NULL THEN s.total_cost_cents_ingested
                ELSE (
                    s.total_input_tokens  * COALESCE(p.r_input,  0)
                  + s.total_output_tokens * COALESCE(p.r_output, 0)
                ) / 10000.0
            END AS new_cost
          FROM scope s
          LEFT JOIN pivoted p USING (device_id, session_id)
    ),
    upd AS (
        UPDATE session_summaries ss
           SET total_cost_cents_effective = nc.new_cost
          FROM new_costs nc
         WHERE ss.device_id  = nc.device_id
           AND ss.session_id = nc.session_id
           AND ss.total_cost_cents_effective IS DISTINCT FROM nc.new_cost
         RETURNING 1
    ),
    proc AS (SELECT COUNT(*) AS c FROM new_costs)
    SELECT
        v_rows_processed + proc.c,
        v_rows_changed   + (SELECT COUNT(*) FROM upd)
      INTO v_rows_processed, v_rows_changed
      FROM proc;

    -- Post-recalc totals, same scoping as the `before` reads.
    SELECT COALESCE(SUM(r.cost_cents_effective), 0)
      INTO v_after_rollups
      FROM daily_rollups r
      JOIN devices d ON d.id = r.device_id
      JOIN users   u ON u.id = d.user_id
     WHERE u.org_id = p_org_id
       AND r.bucket_day BETWEEN p_from_date AND p_to_date;

    SELECT COALESCE(SUM(s.total_cost_cents_effective), 0)
      INTO v_after_sessions
      FROM session_summaries s
      JOIN devices d ON d.id = s.device_id
      JOIN users   u ON u.id = d.user_id
     WHERE u.org_id = p_org_id
       AND COALESCE(s.started_at, s.ended_at, s.synced_at)::date
             BETWEEN p_from_date AND p_to_date;

    UPDATE recalculation_runs
       SET status             = 'succeeded',
           finished_at        = now(),
           rows_processed     = v_rows_processed,
           rows_changed       = v_rows_changed,
           after_total_cents  = v_after_rollups + v_after_sessions
     WHERE id = v_run_id;

    v_result.run_id             := v_run_id;
    v_result.rows_processed     := v_rows_processed;
    v_result.rows_changed       := v_rows_changed;
    v_result.before_total_cents := v_before_rollups + v_before_sessions;
    v_result.after_total_cents  := v_after_rollups  + v_after_sessions;
    RETURN v_result;
END;
$$;

-- ============================================================
-- 3. Permissions
--
-- Only the service-role admin client invokes the engine (the manager-only
-- server actions in #232 route through there). Strip every other role's
-- access; the CI dry-run runs on vanilla Postgres without `service_role`,
-- mirror the guarded GRANT pattern from migration 017.
-- ============================================================

REVOKE ALL ON FUNCTION recalculate_effective_cost(TEXT, DATE, DATE, TEXT)
    FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION recalculate_effective_cost(TEXT, DATE, DATE, TEXT) TO service_role';
    END IF;
END
$$;
