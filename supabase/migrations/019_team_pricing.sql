-- #231: dual cost columns (_ingested / _effective) and per-org pricing tables.
-- Foundation for ADR-0094 "Custom team pricing and effective-cost recalculation"
-- (siropkin/budi#724 epic). The daemon keeps shipping its locally-computed cost
-- under the `_ingested` name; the dashboard reads `_effective`, which a future
-- recalculation engine (siropkin/budi-cloud#233) can rewrite from a team-owned
-- price list. After this migration `_effective == _ingested` for every existing
-- row, so dashboards render unchanged numbers (acceptance criterion 2).
--
-- Why two columns rather than one + an audit table:
--   * Recalc has to run idempotently — re-applying the same price list to a
--     row that already has the right `_effective` value must be a no-op. That
--     needs the original ingested value to stay readable in the same row.
--   * The "list vs. effective delta + savings" widget (#235) reads both columns
--     in a single query path; a separate audit table would force a join on
--     every dashboard load.
--
-- Column rename strategy: hard cut, no compatibility view. The cloud is the
-- only consumer (the daemon writes via the `/v1/ingest` envelope, which is
-- updated in lockstep) and the rename happens inside the same migration that
-- recreates every dashboard RPC, so external query authors never observe an
-- intermediate state. If a future external consumer appears, add a
-- `cost_cents`/`total_cost_cents` view on top — don't reverse the rename.

-- ============================================================
-- 1. Dual cost columns on `daily_rollups`
-- ============================================================

-- Drop CHECK + NOT NULL DEFAULT before renaming so the constraint and column
-- defaults follow the new name. Postgres carries the CHECK across the rename,
-- but re-creating it explicitly under the new name keeps `\d daily_rollups`
-- readable and matches the constraint name we'd want a fresh project to land
-- on.
ALTER TABLE daily_rollups
    DROP CONSTRAINT IF EXISTS daily_rollups_cost_cents_nonneg;

ALTER TABLE daily_rollups
    RENAME COLUMN cost_cents TO cost_cents_effective;

ALTER TABLE daily_rollups
    ADD COLUMN cost_cents_ingested NUMERIC(12,4) NOT NULL DEFAULT 0;

-- Backfill: every existing row's "ingested" cost equals its "effective" cost
-- — no recalculation has happened yet. Future recalc runs (#233) can rewrite
-- `cost_cents_effective` without ever touching `cost_cents_ingested`.
UPDATE daily_rollups SET cost_cents_ingested = cost_cents_effective;

ALTER TABLE daily_rollups
    ADD CONSTRAINT daily_rollups_cost_cents_effective_nonneg
        CHECK (cost_cents_effective >= 0),
    ADD CONSTRAINT daily_rollups_cost_cents_ingested_nonneg
        CHECK (cost_cents_ingested >= 0);

-- ============================================================
-- 2. Dual cost columns on `session_summaries`
-- ============================================================

ALTER TABLE session_summaries
    DROP CONSTRAINT IF EXISTS session_summaries_total_cost_cents_nonneg;

ALTER TABLE session_summaries
    RENAME COLUMN total_cost_cents TO total_cost_cents_effective;

ALTER TABLE session_summaries
    ADD COLUMN total_cost_cents_ingested NUMERIC(12,4) NOT NULL DEFAULT 0;

UPDATE session_summaries SET total_cost_cents_ingested = total_cost_cents_effective;

ALTER TABLE session_summaries
    ADD CONSTRAINT session_summaries_total_cost_cents_effective_nonneg
        CHECK (total_cost_cents_effective >= 0),
    ADD CONSTRAINT session_summaries_total_cost_cents_ingested_nonneg
        CHECK (total_cost_cents_ingested >= 0);

-- ============================================================
-- 3. Recreate every RPC that read `cost_cents` / `total_cost_cents`.
--
-- The dashboard pages keep their existing column names — the RPCs alias
-- `cost_cents_effective AS cost_cents` (and likewise for sessions) so the
-- TypeScript dashboard layer is unaffected. When the recalc engine ships
-- (#233) the same RPCs will continue to read `_effective`, which is exactly
-- what those endpoints already promise.
--
-- Postgres rule: `CREATE OR REPLACE FUNCTION` cannot change a return-type
-- column list — but here we're keeping the output shape identical, just
-- swapping the underlying source column. CREATE OR REPLACE is sufficient.
-- ============================================================

CREATE OR REPLACE FUNCTION public.dashboard_overview_stats(
    p_device_ids   TEXT[],
    p_bucket_from  DATE,
    p_bucket_to    DATE,
    p_surfaces     TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    total_cost_cents     NUMERIC,
    total_input_tokens   BIGINT,
    total_output_tokens  BIGINT,
    total_messages       BIGINT,
    total_sessions       BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH r AS (
        SELECT
            COALESCE(SUM(cost_cents_effective), 0)   AS total_cost_cents,
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
    SELECT r.total_cost_cents, r.total_input_tokens, r.total_output_tokens,
           r.total_messages, s.total_sessions
    FROM r, s;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_daily_activity(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    bucket_day     DATE,
    input_tokens   BIGINT,
    output_tokens  BIGINT,
    cost_cents     NUMERIC,
    message_count  BIGINT
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
        SUM(message_count)::BIGINT    AS message_count
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_cost_by_device(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    device_id      TEXT,
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
        device_id,
        SUM(cost_cents_effective)    AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY device_id;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_cost_by_model(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    provider       TEXT,
    model          TEXT,
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
        provider,
        model,
        SUM(cost_cents_effective)    AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY provider, model;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_cost_by_repo(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    repo_id        TEXT,
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
        repo_id,
        SUM(cost_cents_effective)    AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY repo_id;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_cost_by_branch(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    repo_id        TEXT,
    git_branch     TEXT,
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
        repo_id,
        git_branch,
        SUM(cost_cents_effective)    AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY repo_id, git_branch;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_cost_by_ticket(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    ticket         TEXT,
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
        ticket,
        SUM(cost_cents_effective)    AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND ticket IS NOT NULL
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY ticket;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_team_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    bucket_day      DATE,
    active_members  BIGINT,
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
        r.bucket_day,
        COUNT(DISTINCT d.user_id)::BIGINT AS active_members,
        SUM(r.cost_cents_effective)       AS cost_cents,
        SUM(r.input_tokens)::BIGINT       AS input_tokens,
        SUM(r.output_tokens)::BIGINT      AS output_tokens
    FROM daily_rollups r
    JOIN devices d ON d.id = r.device_id
    WHERE r.device_id = ANY(p_device_ids)
      AND r.bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR r.surface = ANY(p_surfaces))
    GROUP BY r.bucket_day
    ORDER BY r.bucket_day ASC;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_device_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
        SUM(cost_cents_effective)         AS cost_cents,
        SUM(input_tokens)::BIGINT         AS input_tokens,
        SUM(output_tokens)::BIGINT        AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_model_activity_by_day(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
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
        SUM(cost_cents_effective)                  AS cost_cents,
        SUM(input_tokens)::BIGINT                  AS input_tokens,
        SUM(output_tokens)::BIGINT                 AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY bucket_day
    ORDER BY bucket_day ASC;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_activity_heatmap(
    p_device_ids     TEXT[],
    p_started_from   TIMESTAMPTZ,
    p_started_to     TIMESTAMPTZ,
    p_time_zone      TEXT,
    p_surfaces       TEXT[] DEFAULT NULL
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
        COALESCE(SUM(total_cost_cents_effective), 0)                  AS cost_cents
    FROM session_summaries
    WHERE device_id = ANY(p_device_ids)
      AND started_at IS NOT NULL
      AND started_at >= p_started_from
      AND started_at <= p_started_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY 1, 2
    ORDER BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_cost_by_surface(
    p_device_ids  TEXT[],
    p_bucket_from DATE,
    p_bucket_to   DATE,
    p_surfaces    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    surface        TEXT,
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
        surface,
        SUM(cost_cents_effective)    AS cost_cents,
        SUM(input_tokens)::BIGINT    AS input_tokens,
        SUM(output_tokens)::BIGINT   AS output_tokens
    FROM daily_rollups
    WHERE device_id = ANY(p_device_ids)
      AND bucket_day BETWEEN p_bucket_from AND p_bucket_to
      AND (p_surfaces IS NULL OR cardinality(p_surfaces) = 0
           OR surface = ANY(p_surfaces))
    GROUP BY surface;
$$;

-- ============================================================
-- 4. Per-org default pricing context
--
-- A team's "what platform + region do we buy this model from?" defaults. The
-- recalc engine consults these when a price-list row matches multiple
-- (platform, region) combinations for the same model — without a default the
-- engine would have to either ask the user every time or silently pick one.
-- ============================================================

CREATE TABLE org_pricing_defaults (
    org_id            TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    default_platform  TEXT,                        -- e.g. 'anthropic', 'openai', 'bedrock'
    default_region    TEXT,                        -- e.g. 'us-east-1', 'eu-west-1', or NULL for "any"
    updated_by        TEXT REFERENCES users(id),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 5. Price lists (CSV-uploaded, versioned by effective date range)
--
-- One org can have many price lists; the active one(s) at a given date drive
-- recalculation. `status` follows the lifecycle in ADR-0094 §3: a list is
-- uploaded as `draft` (UI shows it but recalc ignores it), promoted to
-- `active` once verified, and `archived` when superseded. Multiple
-- `active` lists are allowed because a team may carry one list for Anthropic
-- direct and a separate list for an enterprise Bedrock contract — the engine
-- picks the row with the most specific (platform, region) match.
-- ============================================================

CREATE TABLE org_price_lists (
    id               BIGSERIAL PRIMARY KEY,
    org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    description      TEXT,
    source_file_name TEXT,                          -- original CSV filename, surfaced in the UI for audit
    effective_from   DATE NOT NULL,
    effective_to     DATE,                          -- NULL = "still in effect"
    status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'active', 'archived')),
    uploaded_by      TEXT REFERENCES users(id),
    uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_price_lists_effective_range
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX idx_org_price_lists_org_status
    ON org_price_lists (org_id, status);

CREATE INDEX idx_org_price_lists_org_effective
    ON org_price_lists (org_id, effective_from, effective_to);

-- ============================================================
-- 6. Price list rows
--
-- One row per (model_pattern, platform, region, token_type) tuple. The
-- `raw_row` JSONB preserves the original CSV row verbatim so a future schema
-- evolution (extra columns, free-form notes) doesn't require a re-upload of
-- existing lists.
--
-- `list_usd_per_mtok` is the vendor's published price; `sale_usd_per_mtok` is
-- what the team actually pays (after enterprise discount, committed-use
-- contract, etc.) — the recalc engine uses `sale_*` for `_effective`. The list
-- price is preserved so the "list vs. effective delta + savings" widget (#235)
-- can show the discount.
-- ============================================================

CREATE TABLE org_price_list_rows (
    id                 BIGSERIAL PRIMARY KEY,
    list_id            BIGINT NOT NULL REFERENCES org_price_lists(id) ON DELETE CASCADE,
    platform           TEXT NOT NULL,
    model_pattern      TEXT NOT NULL,               -- exact model name or a glob; resolved via `model_aliases`
    region             TEXT,                        -- NULL = "all regions"
    token_type         TEXT NOT NULL
                       CHECK (token_type IN ('input', 'output', 'cache_read', 'cache_write')),
    list_usd_per_mtok  NUMERIC(10,4),               -- nullable: not every vendor publishes a list price
    sale_usd_per_mtok  NUMERIC(10,4) NOT NULL,
    raw_row            JSONB,
    CONSTRAINT org_price_list_rows_list_usd_nonneg
        CHECK (list_usd_per_mtok IS NULL OR list_usd_per_mtok >= 0),
    CONSTRAINT org_price_list_rows_sale_usd_nonneg
        CHECK (sale_usd_per_mtok >= 0)
);

CREATE INDEX idx_org_price_list_rows_lookup
    ON org_price_list_rows (list_id, platform, model_pattern, token_type);

-- ============================================================
-- 7. Model aliases
--
-- A display-name → matching-pattern lookup that lets a CSV row keyed on a
-- canonical model name (`claude-haiku-4-5`) match every wire variant the
-- daemon has ever uploaded (`claude-haiku-4.5`, `claude-haiku-4-5-20251001`,
-- the LiteLLM display-name variants from ADR-0091 #443). The recalc engine
-- consults this table when resolving a rollup row's `model` to a price list
-- row's `model_pattern`. Seeded by a separate migration (or by an admin job)
-- so this schema migration stays data-free.
-- ============================================================

CREATE TABLE model_aliases (
    display_name  TEXT PRIMARY KEY,
    patterns      TEXT[] NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 8. Recalculation runs
--
-- One row per recalc invocation. Stores enough context to render the
-- "savings since last recalc" widget (#235) without a separate audit log:
-- which lists drove the run, what window was reprocessed, and the rollup-cost
-- delta before/after. `status` is a free TEXT for now — `running` / `success`
-- / `failed` are the obvious values but more granular states (`partial`,
-- `aborted`) will land as the engine matures.
-- ============================================================

CREATE TABLE recalculation_runs (
    id                  BIGSERIAL PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'running',
    scope_from_date     DATE,
    scope_to_date       DATE,
    price_list_ids      BIGINT[],
    rows_processed      BIGINT,
    rows_changed        BIGINT,
    before_total_cents  NUMERIC(14,4),
    after_total_cents   NUMERIC(14,4),
    triggered_by        TEXT REFERENCES users(id)
);

CREATE INDEX idx_recalculation_runs_org_started
    ON recalculation_runs (org_id, started_at DESC);

-- ============================================================
-- 9. Row-Level Security
--
-- New tables are admin-managed and org-scoped. We mirror the pattern from
-- `001_ingest_schema.sql`: SELECT is scoped to org members; INSERT/UPDATE/
-- DELETE on price-list tables is restricted to managers (the org's "admin"
-- role in v1 per SOUL.md). `recalculation_runs` is admin-write but
-- org-readable: every member should see "the team's costs were recalculated
-- at X", since it changes the numbers on their dashboard.
--
-- The dashboard reads via the service-role admin client and gates manager
-- visibility in `src/lib/dal.ts` (SOUL.md "Admin client vs RLS"); RLS here is
-- defense in depth, identical to how `daily_rollups` is protected today.
-- ============================================================

ALTER TABLE org_pricing_defaults  ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_price_lists       ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_price_list_rows   ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_aliases         ENABLE ROW LEVEL SECURITY;
ALTER TABLE recalculation_runs    ENABLE ROW LEVEL SECURITY;

-- org_pricing_defaults: org members read; managers write.
CREATE POLICY "Users can read org pricing defaults"
    ON org_pricing_defaults FOR SELECT
    USING (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
        )
    );

CREATE POLICY "Managers can write org pricing defaults"
    ON org_pricing_defaults FOR ALL
    USING (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
              AND role = 'manager'
        )
    )
    WITH CHECK (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
              AND role = 'manager'
        )
    );

-- org_price_lists: org members read; managers write.
CREATE POLICY "Users can read org price lists"
    ON org_price_lists FOR SELECT
    USING (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
        )
    );

CREATE POLICY "Managers can write org price lists"
    ON org_price_lists FOR ALL
    USING (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
              AND role = 'manager'
        )
    )
    WITH CHECK (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
              AND role = 'manager'
        )
    );

-- org_price_list_rows: org members read (via list_id → org_id); managers write.
CREATE POLICY "Users can read org price list rows"
    ON org_price_list_rows FOR SELECT
    USING (
        list_id IN (
            SELECT id FROM org_price_lists
            WHERE org_id IN (
                SELECT org_id FROM users
                WHERE id = auth.uid()::text
            )
        )
    );

CREATE POLICY "Managers can write org price list rows"
    ON org_price_list_rows FOR ALL
    USING (
        list_id IN (
            SELECT id FROM org_price_lists
            WHERE org_id IN (
                SELECT org_id FROM users
                WHERE id = auth.uid()::text
                  AND role = 'manager'
            )
        )
    )
    WITH CHECK (
        list_id IN (
            SELECT id FROM org_price_lists
            WHERE org_id IN (
                SELECT org_id FROM users
                WHERE id = auth.uid()::text
                  AND role = 'manager'
            )
        )
    );

-- model_aliases: globally readable (everyone benefits from the lookup table)
-- but no write policy — only the service-role admin client (which bypasses
-- RLS) gets to seed / update entries. Treat it like a system table.
CREATE POLICY "Authenticated users can read model aliases"
    ON model_aliases FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- recalculation_runs: org members read; managers write (a manager kicks off
-- a recalc from the UI; members see the audit trail of when their numbers
-- changed).
CREATE POLICY "Users can read org recalculation runs"
    ON recalculation_runs FOR SELECT
    USING (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
        )
    );

CREATE POLICY "Managers can write org recalculation runs"
    ON recalculation_runs FOR ALL
    USING (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
              AND role = 'manager'
        )
    )
    WITH CHECK (
        org_id IN (
            SELECT org_id FROM users
            WHERE id = auth.uid()::text
              AND role = 'manager'
        )
    );
