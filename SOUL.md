# SOUL.md

Cloud dashboard and ingest API for **budi**. Next.js 16 + React 19 + Supabase, deployed to `app.getbudi.dev`. Receives pre-aggregated daily rollups and session summaries from the budi daemon over HTTPS and renders them as a team-wide dashboard.

This repo is the **optional, opt-in cloud layer**. The product is complete without it. Local-first is the default; the cloud never initiates a connection to a user machine.

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

## Product boundaries

| Product            | Repo                                                                    | Role                                                                                     |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **budi-core**      | [`siropkin/budi`](https://github.com/siropkin/budi)                     | Rust daemon + CLI. Owns SQLite, pushes aggregates to this service.                       |
| **budi-cursor**    | [`siropkin/budi-cursor`](https://github.com/siropkin/budi-cursor)       | VS Code/Cursor extension. Unrelated to the cloud.                                        |
| **budi-jetbrains** | [`siropkin/budi-jetbrains`](https://github.com/siropkin/budi-jetbrains) | JetBrains IDE plugin. Sibling surface to `budi-cursor`.                                  |
| **budi-cloud**     | **this repo** (`siropkin/budi-cloud`)                                   | Cloud dashboard + ingest API.                                                            |
| **homebrew-budi**  | [`siropkin/homebrew-budi`](https://github.com/siropkin/homebrew-budi)   | Homebrew tap for `brew install siropkin/budi/budi`.                                      |
| **getbudi.dev**    | [`siropkin/getbudi.dev`](https://github.com/siropkin/getbudi.dev)       | Public marketing landing page. Different subdomain (`getbudi.dev` vs `app.getbudi.dev`). |

Extraction boundaries are defined in [ADR-0086](https://github.com/siropkin/budi/blob/main/docs/adr/0086-extraction-boundaries.md) in the main repo. The privacy contract is [ADR-0083](https://github.com/siropkin/budi/blob/main/docs/adr/0083-cloud-ingest-identity-and-privacy-contract.md). Read both before touching the ingest path.

## Build & dev

```bash
cp .env.local.example .env.local    # fill in Supabase keys
npm ci
npm run dev                         # http://localhost:3000
npm run build
npm run start                       # serve the production build
npm test                            # vitest
npm run lint
```

Database migrations live in `supabase/migrations/`. Apply them with the Supabase CLI before running against a fresh project. The forward-only policy and the per-migration checklist are in [`supabase/migrations/README.md`](supabase/migrations/README.md) — read it before editing anything in that directory.

## What data the cloud receives

The daemon pushes **pre-aggregated daily rollups and session summaries** — numeric metrics only:

- Token counts (input, output, cache)
- Cost (cents)
- Model names
- Hashed repo IDs (not paths)
- Branch names (but not file paths)
- Ticket IDs (extracted from branch/commit patterns)
- Session durations and message counts

**Never uploaded**: prompts, responses, code, file paths, email addresses, raw payloads, tag values. There is no "full upload" mode, no remote debug channel, no pull endpoint. If you find yourself adding one, stop and re-read ADR-0083.

## Transport & trust model

- **HTTPS only** — the daemon refuses plain HTTP
- **Push-only** — the daemon initiates every connection; the cloud never reaches back to a developer machine
- **Idempotent** — sync uses UPSERT semantics with deterministic keys; retries are safe and produce no duplicates
- **Watermarked** — the daemon only sends rollups newer than the last confirmed sync
- **Auth**: API key in `Authorization: Bearer budi_<key>` for ingest; Supabase Auth (GitHub / Google / magic link) for the web dashboard

## Team model (v1)

| Aspect              | Detail                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **Roles**           | `manager` (view all workspace data, manage members) and `member` (sync own data, view own data) |
| **Granularity**     | Daily aggregates; no per-message, per-hour, or real-time views                                  |
| **Retention**       | 90 days                                                                                         |
| **Multi-workspace** | One user, one workspace (no multi-tenancy per user in v1)                                       |
| **SSO / SAML**      | Not supported in v1                                                                             |

## Ingest API contract

- `POST /v1/ingest` — receives the sync envelope (daily_rollups + session_summaries). Returns 200 on success, 401 on auth failure (daemon stops syncing), 422 on schema mismatch (daemon pauses until update), 429/5xx triggers daemon retry with exponential backoff (1s → 2s → … → 5 min cap).
- `GET /v1/ingest/status?device_id=…` — returns watermark, last-seen timestamp, and record counts for the caller's device.
- Schema for the envelope: see ADR-0083 §2 in the main repo.

## Pages

All dashboard pages live under `/dashboard`:

- `/dashboard` — workspace-wide Overview (totals, trends, daily activity)
- `/dashboard/team` — per-member spend (managers see the full workspace; members see only their own row)
- `/dashboard/devices` — per-device fleet view (counts, cost-per-device)
- `/dashboard/models` — breakdown by model / provider
- `/dashboard/repos` — breakdown by repo / branch / ticket
- `/dashboard/sessions` — session list with health signals; `/dashboard/sessions/[id]` for a single-session drill-down
- `/dashboard/settings` — workspace info, the viewer's API key, members list, and (managers) invite link generation; nested `/dashboard/settings/pricing` for the workspace's price-list overrides

## Window contract and local→cloud linking

- **Time-window filters** — `1d` / `7d` / `30d` / `All` (default `7d`), matching the local Budi contract (ADR-0088 §7). `?days=<N>` accepts any positive integer; `?days=all` is a cloud-only lifetime preset backed by a per-workspace earliest-activity lookup. Presets and default live in `src/lib/periods.ts`.
- **Local→cloud linking** is owned end-to-end here. The header badge (`getSyncFreshness`) reports `not_linked` / `linked_no_data` / `ok` / `stalled`; `LinkDaemonBanner` prompts brand-new accounts with a copyable `budi cloud init --api-key …`; `FirstSyncInProgressBanner` covers the gap between link and first ingest so a just-linked account is never indistinguishable from a broken one. Freshness is inferred from `daily_rollups.synced_at` — push-only, no callback (ADR-0083).
- **Provider-scoped tiles** reuse the shared status contract (`docs/statusline-contract.md` in the main repo). Never blend multi-provider totals into a tile scoped to a single provider like "Cursor" or "Claude Code".

## Key directories

- `src/app/` — Next.js App Router pages, route handlers, and server actions
- `src/app/api/v1/ingest/` — ingest + status route handlers
- `src/app/dashboard/<surface>/_components/` — components owned by a single dashboard surface (see "Where do new components go?" below)
- `src/components/` — primitives reused across two or more surfaces
- `src/components/filters/` — shared filter/control chips (period, units, surface, user)
- `src/components/layout/` — dashboard chrome (sidebar, user menu, sync freshness, timezone sync)
- `src/components/charts/` — chart primitives reused across surfaces (`cost-bar-chart`)
- `src/components/ui/` — generic primitives (card)
- `src/lib/dal/` — data access layer split by domain (`overview.ts`, `team.ts`, `devices.ts`, `models.ts`, `repos.ts`, `sessions.ts`, `pricing.ts`, `sync.ts`, `user.ts`, `surfaces.ts`, `types.ts`); re-exports from `index.ts`. Every dashboard query routes through here — import `from "@/lib/dal"`
- `src/lib/supabase/` — Supabase clients (anon, server, admin/service-role)
- `src/proxy.ts` — Next.js 16 proxy (formerly middleware): refreshes the Supabase session and gates `/dashboard/*`
- `supabase/migrations/` — Postgres schema migrations (apply in order)

## Where do new components go? (#280)

The same flat-vs-by-surface question keeps coming up, so we pin the rule:

- **One consumer → live next to that consumer.** If a component is imported from exactly one page (or one page-group like `sessions/[id]`), put it in that page's `_components/` directory: `src/app/dashboard/<surface>/_components/<name>.tsx`. Charts that only one surface uses (e.g. `device-count-chart`) belong here, not in `src/components/charts/`.
- **Two or more consumers → `src/components/`.** Primitives reused across surfaces stay flat (`page-header`, `responsive-table`, `stat-card`, `cost-bar-chart`).
- **Group by role inside `src/components/`** — `filters/` for URL-driven query chips, `layout/` for the dashboard shell, `charts/` for shared chart primitives, `ui/` for generic primitives. Resist adding a fifth bucket; if a component doesn't fit, it's probably surface-specific (move it under `_components/`).
- **Don't reach across surface boundaries.** A file under `src/app/dashboard/devices/_components/` is private to the devices surface. If another surface starts importing it, that's the signal to promote it to `src/components/` — not to import from a sibling `_components/`.

If you can't decide between "shared primitive" and "surface-owned", start in `_components/` — promoting later is cheaper than untangling cross-surface coupling.

## Server actions vs route handlers

Picking the wrong surface for a mutation or read drifts the boundary between in-app code and the daemon contract — so we pin the rule explicitly (#279):

- **RSC reads → DAL directly.** Server Components import from `src/lib/dal.ts`. No HTTP hop, no route handler, no server action.
- **In-app form mutations → server actions in `src/app/actions/`.** Anything called from a `<form action={…}>` or button in our own pages (workspace/team/pricing settings, sign-out, etc.) belongs here. Re-verify the caller's role on the server — JSX gating is not a security boundary (`pricing.ts`, `workspace.ts`).
- **External callers → route handlers in `src/app/api/`.** "External" means anything that is not one of our own RSCs/forms: the budi daemon, the browser-side reporting APIs, our own client-side polling code. The versioned daemon contract lives under `/api/v1/*` (`ingest`, `ingest/status`, `pricing/active`, `whoami`) — bump the major when the wire shape changes; ADR-0083 §7 in the main repo is the source of truth. Unversioned local utilities sit at `/api/<name>` (`csp-report`, `freshness`).
- **Fixed-URL protocol callbacks are the only exception** to "route handlers live under `/api/`". Supabase's OAuth round-trip lands on `/auth/callback`, so `src/app/auth/callback/route.ts` stays where the provider expects it.

If a new file would violate this rule, move it before merging — don't bend the rule to fit a special case.

## Dev notes

- **Read the privacy contract before adding fields**: every new column on an ingest table must be justified against ADR-0083. If it's a prompt, a file path, an email, or a raw payload, it does not belong here — stop and push back.
- **The cloud is optional**: users can run budi forever without it. Do not design features that silently require cloud sync.
- **Idempotency matters**: all ingest handlers must be safe to retry. Deterministic keys, UPSERT, no side effects outside the transaction.
- **Admin client vs RLS**: the dashboard reads via the service-role admin client and gates manager/member visibility in `src/lib/dal.ts` (see `getVisibleDeviceIds` and the `user.role === "manager"` branches). RLS is enabled on the ingest tables as defense in depth, but the dashboard does not rely on it — add the same JS-side scoping whenever you add a new query.
- **Next.js 16 quirks**: check `node_modules/next/dist/docs/` before assuming App Router / Server Action / caching behavior matches what you remember. See the warning at the top of this file.
- **Lockfile**: commit `package-lock.json`. Deploys must be reproducible.
- **Run prettier before committing wide-sweep changes**: CI's `format` job (`.github/workflows/ci.yml`) runs `npm run format:check` → `prettier --check .` and fails the PR on any drift. Bulk rewrites (`perl -i`, `sed -i`, multi-file renames, migrations that touch the surrounding markdown) don't invoke prettier, so anything bigger than a couple of files needs `npm run format` (or `npx prettier --write .`) and a re-stage before `git commit`. If you've already committed, add a follow-up `style: prettier --write …` commit rather than amending. Pure-identifier sweeps (e.g. `org_id` → `workspace_id`) still need this: prettier reflows surrounding lines as soon as a width or table-alignment changes.
- **Deployment**: Vercel for the app; GitHub Actions for the database. Production environment variables are set in the Vercel dashboard; local uses `.env.local`. Never commit real Supabase service-role keys.
- **Migrations ship via CI, not by hand**: `.github/workflows/db-push.yml` runs `supabase db push --include-all` against the linked production project on every push to `main` that touches `supabase/migrations/**`. PRs that add a migration are dry-run against a fresh Postgres in `.github/workflows/ci.yml` to catch syntax / dependency errors at review time. Do **not** apply migrations through the Supabase SQL editor — that re-introduces the drift that broke the dashboard in #92/#94. If you must hand-apply (incident recovery), run `supabase migration repair` afterwards so `supabase migration list` shows `Local == Remote` again. Required GitHub Actions secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`.
- **New `public.*` tables must bake in explicit GRANTs** (#306): Supabase is flipping the Data API default on **2026-10-30** — after that, any new table in the `public` schema is invisible to `supabase-js`, PostgREST (`/rest/v1/`) and GraphQL (`/graphql/v1/`) until grants are issued (PostgREST returns `42501`). Existing tables keep their current grants — this is forward-only. Every new `CREATE TABLE public.<table>` migration must include the boilerplate below (drop the verbs the table doesn't need), plus `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and policies if the table is reachable from end users:

  ```sql
  grant select on public.<table> to anon;
  grant select, insert, update, delete on public.<table> to authenticated;
  grant select, insert, update, delete on public.<table> to service_role;

  alter table public.<table> enable row level security;
  -- + policies as needed
  ```

  CI enforces this in `.github/workflows/ci.yml` via `supabase/check-grants.sh`, which fails the PR if any `CREATE TABLE public.<table>` lacks a matching `GRANT ... ON public.<table>` in the same migration. The check only fires when the explicit `public.` prefix is used, so existing un-prefixed migrations are grandfathered. Before the 2026-10-30 enforcement date, run the Supabase **Security Advisor** once and confirm no existing tables are missing intended grants.

- **Error surfaces**: when ingest is rejected (bad key, workspace mismatch, schema drift), surface a clear error in the dashboard's Settings page — the daemon will simply stop syncing on 401 and the dashboard is the only place a user will see why.
