-- #178: floor the headline metric columns at the database so a future ingest
-- path that forgets to call `validateIngestMetrics` / the row-builder caps
-- still can't land negative cost or token counts. The application already
-- rejects non-finite + negative inputs with 422 (ADR-0083 §7 daemon-pause
-- signal) and coerces over-large values into `METRIC_CAPS`; these CHECKs are
-- the last line of defense against silent dashboard corruption over the
-- 90-day retention window.
--
-- Only `>= 0` is enforced here, not the upper caps. The caps live in TypeScript
-- (`METRIC_CAPS` in `rows.ts`) where they can evolve without a migration —
-- the column types (BIGINT for tokens, NUMERIC(12,4) for cost_cents) already
-- bound the upper end at the storage layer. Adding upper-bound CHECKs that
-- duplicate the application caps would just create a second source of truth
-- to keep in sync.

ALTER TABLE daily_rollups
    ADD CONSTRAINT daily_rollups_message_count_nonneg
        CHECK (message_count >= 0),
    ADD CONSTRAINT daily_rollups_input_tokens_nonneg
        CHECK (input_tokens >= 0),
    ADD CONSTRAINT daily_rollups_output_tokens_nonneg
        CHECK (output_tokens >= 0),
    ADD CONSTRAINT daily_rollups_cache_creation_tokens_nonneg
        CHECK (cache_creation_tokens >= 0),
    ADD CONSTRAINT daily_rollups_cache_read_tokens_nonneg
        CHECK (cache_read_tokens >= 0),
    ADD CONSTRAINT daily_rollups_cost_cents_nonneg
        CHECK (cost_cents >= 0);

ALTER TABLE session_summaries
    ADD CONSTRAINT session_summaries_message_count_nonneg
        CHECK (message_count >= 0),
    ADD CONSTRAINT session_summaries_total_input_tokens_nonneg
        CHECK (total_input_tokens >= 0),
    ADD CONSTRAINT session_summaries_total_output_tokens_nonneg
        CHECK (total_output_tokens >= 0),
    ADD CONSTRAINT session_summaries_total_cost_cents_nonneg
        CHECK (total_cost_cents >= 0);
