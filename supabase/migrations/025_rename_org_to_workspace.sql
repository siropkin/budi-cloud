-- #321: Rename org → workspace in the schema.
--
-- #315 / #320 renamed "Organization" → "Workspace" in user-facing UI but
-- deliberately left identifiers (DB schema, code, wire format) untouched.
-- This migration finishes the rename on the database side so the schema
-- stops contradicting the UX. The code rename (server actions, components,
-- DAL helpers) and the dual-emit wire-format change land in the same PR.
--
-- Renames done here, forward-only:
--   Tables   : orgs                      → workspaces
--              org_pricing_defaults      → workspace_pricing_defaults
--              org_price_lists           → workspace_price_lists
--              org_price_list_rows       → workspace_price_list_rows
--   Columns  : users.org_id              → users.workspace_id
--              invite_tokens.org_id      → invite_tokens.workspace_id
--              workspace_pricing_defaults.org_id  → workspace_id
--              workspace_price_lists.org_id       → workspace_id
--              recalculation_runs.org_id          → workspace_id
--   Indexes  : idx_org_price_lists_*     → idx_workspace_price_lists_*
--              idx_org_price_list_rows_* → idx_workspace_price_list_rows_*
--              idx_recalculation_runs_org_started → ..._workspace_started
--   Funcs    : delete_org_cascade(TEXT)  → delete_workspace_cascade(TEXT)
--              recalculate_effective_cost: param p_org_id → p_workspace_id
--   Policies : renamed to use "workspace" instead of "org"
--   Constraints: org_price_lists_effective_range, org_price_list_rows_* → workspace_*
--
-- Postgres auto-rewrites RLS policy expressions, foreign keys, and index
-- definitions when a column or table is renamed, so most of the work is
-- mechanical. The two functions need to be re-issued because their bodies
-- are stored as text and reference the old names verbatim.

-- ============================================================
-- 1. Drop the functions that reference the old table / column names.
--    They are recreated at the bottom of the migration once the rename
--    is complete.
-- ============================================================

DROP FUNCTION IF EXISTS public.delete_org_cascade(TEXT);
DROP FUNCTION IF EXISTS public.recalculate_effective_cost(TEXT, DATE, DATE, TEXT);

-- ============================================================
-- 2. Rename tables.
--    FKs, indexes, RLS policies, and CHECK constraints follow the table.
-- ============================================================

ALTER TABLE orgs                  RENAME TO workspaces;
ALTER TABLE org_pricing_defaults  RENAME TO workspace_pricing_defaults;
ALTER TABLE org_price_lists       RENAME TO workspace_price_lists;
ALTER TABLE org_price_list_rows   RENAME TO workspace_price_list_rows;

-- ============================================================
-- 3. Rename the `org_id` column → `workspace_id` everywhere.
--    Postgres rewrites FK, index, and RLS policy expressions in place.
-- ============================================================

ALTER TABLE users                       RENAME COLUMN org_id TO workspace_id;
ALTER TABLE invite_tokens               RENAME COLUMN org_id TO workspace_id;
ALTER TABLE workspace_pricing_defaults  RENAME COLUMN org_id TO workspace_id;
ALTER TABLE workspace_price_lists       RENAME COLUMN org_id TO workspace_id;
ALTER TABLE recalculation_runs          RENAME COLUMN org_id TO workspace_id;

-- ============================================================
-- 4. Rename indexes that carry `org` in their name (cosmetic but the
--    point of this migration is to stop the schema saying "org").
-- ============================================================

ALTER INDEX idx_org_price_lists_org_status     RENAME TO idx_workspace_price_lists_workspace_status;
ALTER INDEX idx_org_price_lists_org_effective  RENAME TO idx_workspace_price_lists_workspace_effective;
ALTER INDEX idx_org_price_list_rows_lookup     RENAME TO idx_workspace_price_list_rows_lookup;
ALTER INDEX idx_recalculation_runs_org_started RENAME TO idx_recalculation_runs_workspace_started;

-- ============================================================
-- 5. Rename CHECK constraints that carry `org` in their name.
-- ============================================================

ALTER TABLE workspace_price_lists
    RENAME CONSTRAINT org_price_lists_effective_range
                   TO workspace_price_lists_effective_range;

ALTER TABLE workspace_price_list_rows
    RENAME CONSTRAINT org_price_list_rows_list_usd_nonneg
                   TO workspace_price_list_rows_list_usd_nonneg;

ALTER TABLE workspace_price_list_rows
    RENAME CONSTRAINT org_price_list_rows_sale_usd_nonneg
                   TO workspace_price_list_rows_sale_usd_nonneg;

-- ============================================================
-- 6. Rename RLS policies. Policy names are cosmetic but the dashboard
--    advisors flag the drift and a future audit will not match "org"
--    against a workspace-shaped schema.
-- ============================================================

ALTER POLICY "Users can read own org"            ON workspaces                 RENAME TO "Users can read own workspace";
ALTER POLICY "Users can read org members"        ON users                      RENAME TO "Users can read workspace members";
ALTER POLICY "Users can read org devices"        ON devices                    RENAME TO "Users can read workspace devices";
ALTER POLICY "Users can read org daily_rollups"  ON daily_rollups              RENAME TO "Users can read workspace daily_rollups";
ALTER POLICY "Users can read org session_summaries"
                                                 ON session_summaries          RENAME TO "Users can read workspace session_summaries";

ALTER POLICY "Managers can read org invite tokens"
                                                 ON invite_tokens              RENAME TO "Managers can read workspace invite tokens";
ALTER POLICY "Managers can create invite tokens" ON invite_tokens              RENAME TO "Managers can create workspace invite tokens";

ALTER POLICY "Managers can read org invite redemptions"
                                                 ON invite_redemptions         RENAME TO "Managers can read workspace invite redemptions";

ALTER POLICY "Users can read org pricing defaults"
                                                 ON workspace_pricing_defaults RENAME TO "Users can read workspace pricing defaults";
ALTER POLICY "Managers can write org pricing defaults"
                                                 ON workspace_pricing_defaults RENAME TO "Managers can write workspace pricing defaults";
ALTER POLICY "Users can read org price lists"    ON workspace_price_lists      RENAME TO "Users can read workspace price lists";
ALTER POLICY "Managers can write org price lists"
                                                 ON workspace_price_lists      RENAME TO "Managers can write workspace price lists";
ALTER POLICY "Users can read org price list rows"
                                                 ON workspace_price_list_rows  RENAME TO "Users can read workspace price list rows";
ALTER POLICY "Managers can write org price list rows"
                                                 ON workspace_price_list_rows  RENAME TO "Managers can write workspace price list rows";
ALTER POLICY "Users can read org recalculation runs"
                                                 ON recalculation_runs         RENAME TO "Users can read workspace recalculation runs";
ALTER POLICY "Managers can write org recalculation runs"
                                                 ON recalculation_runs         RENAME TO "Managers can write workspace recalculation runs";

-- ============================================================
-- 7. Re-create the workspace-cascade delete RPC (was delete_org_cascade).
--    Behaviour is unchanged from migration 024 — only names move.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_workspace_cascade(p_workspace_id TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_ids      TEXT[];
    v_device_ids    TEXT[];
    v_users_deleted BIGINT;
BEGIN
    IF p_workspace_id IS NULL THEN
        RAISE EXCEPTION 'delete_workspace_cascade: p_workspace_id is required';
    END IF;

    SELECT COALESCE(array_agg(id), ARRAY[]::TEXT[])
      INTO v_user_ids
      FROM users
     WHERE workspace_id = p_workspace_id;

    SELECT COALESCE(array_agg(id), ARRAY[]::TEXT[])
      INTO v_device_ids
      FROM devices
     WHERE user_id = ANY(v_user_ids);

    DELETE FROM session_summaries WHERE device_id = ANY(v_device_ids);
    DELETE FROM daily_rollups     WHERE device_id = ANY(v_device_ids);
    DELETE FROM devices           WHERE user_id   = ANY(v_user_ids);

    DELETE FROM workspace_price_list_rows
     WHERE list_id IN (
         SELECT id FROM workspace_price_lists WHERE workspace_id = p_workspace_id
     );
    DELETE FROM workspace_price_lists       WHERE workspace_id = p_workspace_id;
    DELETE FROM workspace_pricing_defaults  WHERE workspace_id = p_workspace_id;
    DELETE FROM recalculation_runs          WHERE workspace_id = p_workspace_id;

    DELETE FROM invite_tokens WHERE workspace_id = p_workspace_id;

    DELETE FROM users WHERE workspace_id = p_workspace_id;
    GET DIAGNOSTICS v_users_deleted = ROW_COUNT;

    DELETE FROM workspaces WHERE id = p_workspace_id;

    RETURN v_users_deleted;
END;
$$;

REVOKE ALL ON FUNCTION delete_workspace_cascade(TEXT) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION delete_workspace_cascade(TEXT) TO service_role';
    END IF;
END
$$;

-- ============================================================
-- 8. Re-create recalculate_effective_cost with the workspace-shaped
--    parameter name. Body is otherwise identical to migration 021.
-- ============================================================

CREATE OR REPLACE FUNCTION public.recalculate_effective_cost(
    p_workspace_id  TEXT,
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

    SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::BIGINT[])
      INTO v_active_list_ids
      FROM workspace_price_lists
     WHERE workspace_id = p_workspace_id
       AND status = 'active'
       AND effective_from <= p_to_date
       AND (effective_to IS NULL OR effective_to >= p_from_date);

    SELECT COALESCE(SUM(r.cost_cents_effective), 0)
      INTO v_before_rollups
      FROM daily_rollups r
      JOIN devices d ON d.id = r.device_id
      JOIN users   u ON u.id = d.user_id
     WHERE u.workspace_id = p_workspace_id
       AND r.bucket_day BETWEEN p_from_date AND p_to_date;

    SELECT COALESCE(SUM(s.total_cost_cents_effective), 0)
      INTO v_before_sessions
      FROM session_summaries s
      JOIN devices d ON d.id = s.device_id
      JOIN users   u ON u.id = d.user_id
     WHERE u.workspace_id = p_workspace_id
       AND COALESCE(s.started_at, s.ended_at, s.synced_at)::date
             BETWEEN p_from_date AND p_to_date;

    INSERT INTO recalculation_runs (
        workspace_id, status, scope_from_date, scope_to_date,
        price_list_ids, before_total_cents, triggered_by
    ) VALUES (
        p_workspace_id, 'running', p_from_date, p_to_date,
        v_active_list_ids, v_before_rollups + v_before_sessions, p_triggered_by
    )
    RETURNING id INTO v_run_id;

    WITH defaults AS (
        SELECT default_platform, default_region
          FROM workspace_pricing_defaults
         WHERE workspace_id = p_workspace_id
    ),
    scope AS (
        SELECT r.*
          FROM daily_rollups r
          JOIN devices d ON d.id = r.device_id
          JOIN users   u ON u.id = d.user_id
         WHERE u.workspace_id = p_workspace_id
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
          JOIN workspace_price_lists al
            ON al.workspace_id = p_workspace_id
           AND al.status = 'active'
           AND s.bucket_day
               BETWEEN al.effective_from
                   AND COALESCE(al.effective_to, 'infinity'::date)
          JOIN workspace_price_list_rows plr ON plr.list_id = al.id
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
                    (region IS NOT NULL) DESC,
                    exact_model DESC,
                    price_row_id
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

    WITH defaults AS (
        SELECT default_platform, default_region
          FROM workspace_pricing_defaults
         WHERE workspace_id = p_workspace_id
    ),
    scope AS (
        SELECT s.*,
               COALESCE(s.started_at, s.ended_at, s.synced_at)::date AS bucket_day
          FROM session_summaries s
          JOIN devices d ON d.id = s.device_id
          JOIN users   u ON u.id = d.user_id
         WHERE u.workspace_id = p_workspace_id
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
          JOIN workspace_price_lists al
            ON al.workspace_id = p_workspace_id
           AND al.status = 'active'
           AND s.bucket_day
               BETWEEN al.effective_from
                   AND COALESCE(al.effective_to, 'infinity'::date)
          JOIN workspace_price_list_rows plr ON plr.list_id = al.id
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

    SELECT COALESCE(SUM(r.cost_cents_effective), 0)
      INTO v_after_rollups
      FROM daily_rollups r
      JOIN devices d ON d.id = r.device_id
      JOIN users   u ON u.id = d.user_id
     WHERE u.workspace_id = p_workspace_id
       AND r.bucket_day BETWEEN p_from_date AND p_to_date;

    SELECT COALESCE(SUM(s.total_cost_cents_effective), 0)
      INTO v_after_sessions
      FROM session_summaries s
      JOIN devices d ON d.id = s.device_id
      JOIN users   u ON u.id = d.user_id
     WHERE u.workspace_id = p_workspace_id
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

REVOKE ALL ON FUNCTION recalculate_effective_cost(TEXT, DATE, DATE, TEXT) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION recalculate_effective_cost(TEXT, DATE, DATE, TEXT) TO service_role';
    END IF;
END
$$;
