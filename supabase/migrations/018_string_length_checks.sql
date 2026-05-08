-- #177: floor user-controlled string columns at the database so a future
-- ingest path that forgets to call the row-builder (`buildRollupRows` /
-- `buildSessionRows`) still can't land unbounded strings on a single column.
-- The application already truncates inputs in `STRING_CAPS` (`rows.ts`); these
-- CHECKs are the last line of defense against the same dashboard-wide damage
-- 016 guards against on the numeric side: a single bad row that bloats
-- storage and slows every aggregate query for the 90-day retention window.
--
-- Bounds match `STRING_CAPS` exactly. If a future change relaxes a TypeScript
-- cap the migration must be relaxed in lockstep — the same trade-off ADR-0083
-- §7 documents for the metric range checks. Nullable columns admit NULL
-- explicitly so existing rows where the daemon legitimately omitted the
-- field (e.g. `ticket`) keep validating.

ALTER TABLE daily_rollups
    ADD CONSTRAINT daily_rollups_role_length
        CHECK (length(role) <= 32),
    ADD CONSTRAINT daily_rollups_provider_length
        CHECK (length(provider) <= 64),
    ADD CONSTRAINT daily_rollups_model_length
        CHECK (length(model) <= 128),
    ADD CONSTRAINT daily_rollups_repo_id_length
        CHECK (length(repo_id) <= 128),
    ADD CONSTRAINT daily_rollups_git_branch_length
        CHECK (length(git_branch) <= 256),
    ADD CONSTRAINT daily_rollups_ticket_length
        CHECK (ticket IS NULL OR length(ticket) <= 64);

ALTER TABLE session_summaries
    ADD CONSTRAINT session_summaries_session_id_length
        CHECK (length(session_id) <= 128),
    ADD CONSTRAINT session_summaries_provider_length
        CHECK (length(provider) <= 64),
    ADD CONSTRAINT session_summaries_repo_id_length
        CHECK (repo_id IS NULL OR length(repo_id) <= 128),
    ADD CONSTRAINT session_summaries_git_branch_length
        CHECK (git_branch IS NULL OR length(git_branch) <= 256),
    ADD CONSTRAINT session_summaries_ticket_length
        CHECK (ticket IS NULL OR length(ticket) <= 64),
    ADD CONSTRAINT session_summaries_main_model_length
        CHECK (main_model IS NULL OR length(main_model) <= 128);
