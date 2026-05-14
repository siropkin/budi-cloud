-- #276: make `Delete organization` actually delete the org.
--
-- Two compounding bugs in the original implementation:
--
--   1. FKs added by later migrations point at `users(id)` with no `ON DELETE`
--      action — so `DELETE FROM users WHERE org_id = $1` raises
--      `foreign_key_violation` from Postgres whenever the manager ever
--      uploaded a price list (#232) or kicked off a recalc (#233):
--
--        * `invite_tokens.created_by`            → users(id)   (002)
--        * `org_pricing_defaults.updated_by`     → users(id)   (019)
--        * `org_price_lists.uploaded_by`         → users(id)   (019)
--        * `recalculation_runs.triggered_by`     → users(id)   (019)
--
--   2. The TypeScript caller (`deleteOrganization` in `src/app/actions/org.ts`)
--      never inspected `{ error }` on any of the per-table deletes, so the FK
--      violation in (1) was discarded and the action proceeded straight to
--      `signOut()` + `redirect("/login")`. The UI looked successful; the org,
--      its users, and the pricing rows all survived in the database.
--
-- This migration takes both fixes:
--
--   * Re-declare the four FKs above with an `ON DELETE` action so future
--     deletes don't silently break when new audit columns land. `updated_by`
--     / `uploaded_by` / `triggered_by` are nullable audit pointers — keeping
--     the row but losing the "who" is exactly what we want once the user is
--     gone, so `SET NULL`. `invite_tokens.created_by` is `NOT NULL`, so
--     `SET NULL` isn't an option — `CASCADE` is the right call (a token
--     issued by a manager who is being deleted has no one to honour it).
--
--   * Add a `delete_org_cascade(p_org_id TEXT)` SECURITY DEFINER function
--     that wipes every org-scoped row in dependency order, *as a single
--     transaction*. The caller side gets to issue one `supabase.rpc(...)`
--     and check one `{ error }` — any FK violation rolls the whole thing
--     back rather than leaving the org half-deleted (the third bug from
--     #276: six independent statements, no rollback).

-- ============================================================
-- 1. Add ON DELETE actions to the FKs that block `DELETE FROM users`
-- ============================================================

ALTER TABLE invite_tokens
    DROP CONSTRAINT IF EXISTS invite_tokens_created_by_fkey;
ALTER TABLE invite_tokens
    ADD CONSTRAINT invite_tokens_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE org_pricing_defaults
    DROP CONSTRAINT IF EXISTS org_pricing_defaults_updated_by_fkey;
ALTER TABLE org_pricing_defaults
    ADD CONSTRAINT org_pricing_defaults_updated_by_fkey
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE org_price_lists
    DROP CONSTRAINT IF EXISTS org_price_lists_uploaded_by_fkey;
ALTER TABLE org_price_lists
    ADD CONSTRAINT org_price_lists_uploaded_by_fkey
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE recalculation_runs
    DROP CONSTRAINT IF EXISTS recalculation_runs_triggered_by_fkey;
ALTER TABLE recalculation_runs
    ADD CONSTRAINT recalculation_runs_triggered_by_fkey
        FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL;

-- ============================================================
-- 2. Transactional org-delete RPC
--
-- One function, one transaction. The order mirrors `ORG_CASCADE_ORDER` in
-- `src/app/actions/org-cascade.ts` (kept in sync by `org.test.ts`). The
-- pricing tables already declare `ON DELETE CASCADE` on `org_id → orgs(id)`,
-- so deleting `orgs` would clean them up by itself — but we delete them
-- explicitly first as defense-in-depth and because it makes the cascade
-- order self-documenting in one place rather than split between SQL and TS.
--
-- Returns the number of `users` deleted so the caller can sanity-check
-- (e.g. log "deleted 4 users from org_xyz" / surface to the UI).
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_org_cascade(p_org_id TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_ids    TEXT[];
    v_device_ids  TEXT[];
    v_users_deleted BIGINT;
BEGIN
    IF p_org_id IS NULL THEN
        RAISE EXCEPTION 'delete_org_cascade: p_org_id is required';
    END IF;

    SELECT COALESCE(array_agg(id), ARRAY[]::TEXT[])
      INTO v_user_ids
      FROM users
     WHERE org_id = p_org_id;

    SELECT COALESCE(array_agg(id), ARRAY[]::TEXT[])
      INTO v_device_ids
      FROM devices
     WHERE user_id = ANY(v_user_ids);

    -- Leaves first (no FKs point at these).
    DELETE FROM session_summaries WHERE device_id = ANY(v_device_ids);
    DELETE FROM daily_rollups     WHERE device_id = ANY(v_device_ids);
    DELETE FROM devices           WHERE user_id   = ANY(v_user_ids);

    -- Pricing surface: rows → lists → defaults → audit runs. The `org_id`
    -- FKs already CASCADE from `orgs`, but doing them explicitly here means
    -- the order is auditable from one place and the same function works if
    -- the cascade actions are ever rolled back.
    DELETE FROM org_price_list_rows
     WHERE list_id IN (SELECT id FROM org_price_lists WHERE org_id = p_org_id);
    DELETE FROM org_price_lists       WHERE org_id = p_org_id;
    DELETE FROM org_pricing_defaults  WHERE org_id = p_org_id;
    DELETE FROM recalculation_runs    WHERE org_id = p_org_id;

    -- Invites: tokens reference users(id) via `created_by` (now CASCADE),
    -- and `invite_redemptions` references both tokens and users with
    -- CASCADE (migration 003), so deleting tokens first is enough. Doing
    -- it before `users` keeps the deletion graph traversable even if a
    -- future column drops one of those cascade actions.
    DELETE FROM invite_tokens WHERE org_id = p_org_id;

    -- Now the FK landscape is clear for the `users` delete.
    DELETE FROM users WHERE org_id = p_org_id;
    GET DIAGNOSTICS v_users_deleted = ROW_COUNT;

    DELETE FROM orgs WHERE id = p_org_id;

    RETURN v_users_deleted;
END;
$$;

-- Only the service-role admin client invokes this from the server action.
-- CI dry-run runs on vanilla Postgres without `service_role`; mirror the
-- guarded GRANT pattern from migration 017 / 021.
REVOKE ALL ON FUNCTION delete_org_cascade(TEXT) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION delete_org_cascade(TEXT) TO service_role';
    END IF;
END
$$;
