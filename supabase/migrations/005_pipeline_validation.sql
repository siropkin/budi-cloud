-- No-op migration — validates the deploy pipeline added in #95.
--
-- Contains zero DDL on purpose. The point is to exercise:
--   1. The PR-time `migrations` job in `.github/workflows/ci.yml` (Postgres
--      service container replays every migration; this file must apply
--      cleanly).
--   2. The post-merge `.github/workflows/db-push.yml` workflow
--      (`supabase db push --include-all` should register version `005`
--      in the remote `supabase_migrations.schema_migrations` table).
--
-- After merging this PR, `supabase migration list --linked` should show
-- `005` on both Local and Remote. Schema is unchanged either way.

SELECT 1;
