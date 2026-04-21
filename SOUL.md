# SOUL.md

Cloud dashboard and ingest API for **budi**. Next.js 16 + Supabase, deployed to `app.getbudi.dev`. Receives pre-aggregated daily rollups and session summaries from the budi daemon over HTTPS and renders them as a team-wide dashboard.

This repo is the **optional, opt-in cloud layer**. The product is complete without it. Local-first is the default; the cloud never initiates a connection to a user machine.

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

## Product boundaries

| Product | Repo | Role |
|---------|------|------|
| **budi-core** | [`siropkin/budi`](https://github.com/siropkin/budi) | Rust daemon + CLI. Owns SQLite, pushes aggregates to this service. |
| **budi-cursor** | [`siropkin/budi-cursor`](https://github.com/siropkin/budi-cursor) | VS Code/Cursor extension. Unrelated to the cloud. |
| **budi-cloud** | **this repo** (`siropkin/budi-cloud`) | Cloud dashboard + ingest API. |
| **getbudi.dev** | [`siropkin/getbudi.dev`](https://github.com/siropkin/getbudi.dev) | Public marketing landing page. Different subdomain (`getbudi.dev` vs `app.getbudi.dev`). |

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

Database migrations live in `supabase/migrations/`. Apply them with the Supabase CLI before running against a fresh project.

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

| Aspect | Detail |
|--------|--------|
| **Roles** | `manager` (view all org data, manage members) and `member` (sync own data, view own data) |
| **Granularity** | Daily aggregates; no per-message, per-hour, or real-time views |
| **Retention** | 90 days |
| **Multi-org** | One user, one org (no multi-tenancy per user in v1) |
| **SSO / SAML** | Not supported in v1 |

## Ingest API contract

- `POST /v1/ingest` — receives the sync envelope (daily_rollups + session_summaries). Returns 200 on success, 401 on auth failure (daemon stops syncing), 422 on schema mismatch (daemon pauses until update), 429/5xx triggers daemon retry with exponential backoff (1s → 2s → … → 5min cap).
- `GET /v1/ingest/status` — returns watermark + last-sync timestamp for the caller's API key.
- Schema for the envelope: see ADR-0083 §2 in the main repo.

## Pages

All dashboard pages live under `/dashboard`:

- `/dashboard` — org-wide Overview (totals, trends, top models, top repos)
- `/dashboard/team` — members, per-member spend (manager only)
- `/dashboard/models` — breakdown by model / provider
- `/dashboard/repos` — breakdown by repo / branch
- `/dashboard/sessions` — session list with health signals
- `/dashboard/settings` — org settings, API keys, retention

## Window contract and local→cloud linking (8.1)

- **Time-window filters are `1d` / `7d` / `30d`** (default `7d`), matching the local Budi contract so the local and cloud surfaces tell the same story (ADR-0088 §7, siropkin/budi#235). `?days=30` deep links still resolve; only the default and the selector presets changed — the old `7d` / `30d` / `90d` presets were retired. Any positive integer passed through `?days=` still renders a valid custom window. The cloud additionally exposes `?days=all` as a lifetime preset backed by a per-org earliest-activity lookup — local Budi has no equivalent because local stats are ephemeral, so this is a cloud-only extension of the contract.
- **Local→cloud linking flow** is owned end to end by this repo. The header badge shows one of `not_linked` / `linked_no_data` / `ok` / `stalled` via `getSyncFreshness`, the Overview page renders a `LinkDaemonBanner` with a copyable `budi cloud init --api-key …` command for brand-new accounts, and a `FirstSyncInProgressBanner` covers the window between link and first ingest so a just-linked account is never indistinguishable from a broken one. The cloud cannot initiate connections back to a developer machine (push-only, ADR-0083); freshness is inferred from the most recent `daily_rollups.synced_at`.
- **Provider-scoped tiles reuse the shared status contract** (`docs/statusline-contract.md` in the main repo). Tiles that claim to show "Cursor" or "Claude Code" must filter by that provider — never blend multi-provider totals in a provider-scoped tile.

## Key directories

- `src/app/` — Next.js App Router pages and layouts
- `src/components/` — UI components (Tailwind)
- `src/lib/` — Supabase client, ingest validation, auth helpers
- `src/proxy.ts` — edge/middleware routing (if used)
- `supabase/migrations/` — Postgres schema migrations
- `supabase/functions/` — Supabase Edge Functions (if any)

## Dev notes

- **Read the privacy contract before adding fields**: every new column on an ingest table must be justified against ADR-0083. If it's a prompt, a file path, an email, or a raw payload, it does not belong here — stop and push back.
- **The cloud is optional**: users can run budi forever without it. Do not design features that silently require cloud sync.
- **Idempotency matters**: all ingest handlers must be safe to retry. Deterministic keys, UPSERT, no side effects outside the transaction.
- **Manager-only endpoints are enforced at the Supabase RLS layer**, not just in the Next.js handlers. If you add a new query, add or verify the corresponding RLS policy.
- **Next.js 16 quirks**: check `node_modules/next/dist/docs/` before assuming App Router / Server Action / caching behavior matches what you remember. See the warning at the top of this file.
- **Lockfile**: commit `package-lock.json`. Deploys must be reproducible.
- **Deployment**: Vercel. Production environment variables are set in the Vercel dashboard; local uses `.env.local`. Never commit real Supabase service-role keys.
- **Error surfaces**: when a new API key fails ingest, surface a clear error in the dashboard's Settings page — do not make users dig through logs. The daemon will stop syncing on 401 and this is the only place they'll see why.
