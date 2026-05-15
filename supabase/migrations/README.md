# Supabase migrations policy

`supabase/migrations/` is the source of truth for the cloud's Postgres schema. Every change applied to the production database lands here first as a numbered SQL file. This README is the policy that keeps that promise true.

If you came here from [SOUL.md](../../SOUL.md), read it before editing anything under this directory.

## The one rule

> **Never edit a merged migration. Add a new one.**

Once a migration is on `main`, treat its contents as immutable. The CI job (`.github/workflows/db-push.yml`) only ever runs `supabase db push --include-all` against production — there is no replay, no down-migration, no rollback. Editing a historical file changes what a fresh project gets and what production has, in opposite directions, and you won't notice until the dashboard breaks on a new Supabase project (see #92, #94).

If you need to change something a previous migration created, write a new migration that performs the change forward:

- Wrong column type? → new migration with `ALTER TABLE ... ALTER COLUMN ... TYPE ...`.
- Bad index? → new migration with `DROP INDEX` + `CREATE INDEX`.
- Function signature evolved? → new migration with `DROP FUNCTION IF EXISTS old_sig` + `CREATE OR REPLACE FUNCTION new_sig`.
- Renamed column? → see #019 for the pattern (rename + backfill + recreate dependents, all in one migration).

The only thing you may safely "edit" on a merged migration is a comment-only fix that does not change a single executable token — and even that is rarely worth the diff.

## File layout and ordering

- **Naming:** `NNN_short_snake_case_description.sql`, where `NNN` is a zero-padded three-digit sequence number (`001`, `002`, …, `024`, `025`, …). Pick the next free number — do not skip and do not reuse.
- **One concern per file.** Don't pile a refactor into a feature migration.
- **No timestamps in filenames.** This repo deliberately uses sequence numbers, not Supabase's default `YYYYMMDDHHMMSS_*.sql`, because the only writer is the CI job applying every migration in lexicographic order to a freshly-linked project. Sequence numbers make the order trivially auditable in a directory listing.
- **Lexicographic = execution order.** `supabase db push --include-all` runs files in filename order. If migration `B` depends on migration `A`, give `B` the higher number.

## Forward-only checklist

Before opening a PR that adds a migration:

- [ ] The filename uses the next free `NNN_` prefix.
- [ ] No statement drops or alters an object in a way that would silently break a later migration (run the migrations end-to-end against a fresh database — `npm run db:reset` if wired up, or `supabase db reset` locally).
- [ ] No `INSERT INTO …` adds environment-specific seed data (test users, demo orgs, dev-only API keys). Backfill of columns from columns already in the row is fine and expected.
- [ ] If the migration `CREATE TABLE public.<x>`, it also issues explicit `GRANT … ON public.<x>` and enables RLS with policies as appropriate. The `supabase/check-grants.sh` CI step enforces this — see [SOUL.md §Dev notes](../../SOUL.md) and #306 for context.
- [ ] If the migration relies on an RLS guarantee, the table layer (`src/lib/dal/…`) does not also rely on it — RLS is defense-in-depth, the DAL still gates manager/member visibility in JS.
- [ ] You did not edit any existing migration file. Run `git diff main -- supabase/migrations/` and confirm only additions.

## Testing against a fresh project

The single test that matters is: **can a brand-new Supabase project apply every migration in this directory, in order, with no errors?** That is what CI runs in `.github/workflows/ci.yml` against an ephemeral Postgres and what `.github/workflows/db-push.yml` runs against production on merge.

Locally:

```bash
# Apply every migration to a fresh local Supabase project.
supabase db reset            # drops the local DB, re-applies all migrations
supabase db push --dry-run   # show what would change against the linked project
```

Do **not** apply migrations through the Supabase SQL editor. That re-introduces the drift that broke the dashboard in #92/#94. If you must hand-apply during incident recovery, run `supabase migration repair` afterwards so `supabase migration list` shows `Local == Remote`.

## RLS guarantees the table layer leans on

The DAL (`src/lib/dal/`) reads via the service-role admin client and gates manager/member visibility in JS (see `getVisibleDeviceIds` and the `user.role === "manager"` branches). RLS is enabled on ingest tables as defense in depth, **but the dashboard does not require it to be correct.** When you add a new query, add the same JS-side scoping; do not depend on RLS to keep one org's rows out of another org's response.

Concretely, the policy that the table layer can assume:

- Every ingest-side table (`daily_rollups`, `session_summaries`, …) has RLS enabled.
- Service-role queries bypass RLS — the admin client sees everything by design.
- Anything anon/authenticated touches goes through PostgREST and is RLS-filtered.

If you add a table that is reachable from end users (e.g. via `supabase-js` on the dashboard), it **must** ship with `ENABLE ROW LEVEL SECURITY` and an explicit policy in the same migration. Tables only the admin client and the ingest path touch still enable RLS — there is no good reason to leave it off.

## Filing audit follow-ups

If you spot a migration that violates this policy, do not edit it. Open an issue titled `cleanup: migration NNN — <what's wrong>` against the housekeeping milestone and link the affected file. A new follow-up migration is the only acceptable fix.
