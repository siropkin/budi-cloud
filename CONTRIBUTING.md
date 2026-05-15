# Contributing to budi-cloud

Welcome! This is the optional cloud layer for [budi](https://github.com/siropkin/budi). The product is complete without it — please read [`README.md`](README.md) first for the high-level overview, and [`SOUL.md`](SOUL.md) for the deeper architectural map.

This file is the **"start here"** for getting a working dev environment and landing a PR. If you only read one doc before opening a pull request, this is the one.

## Prerequisites

- **Node.js 20.x** — CI runs on Node 20 (`.github/workflows/ci.yml`). Newer LTS versions usually work, but PRs must keep Node 20 green.
- **npm** — bundled with Node.js. The lockfile is `package-lock.json`; do not switch to yarn/pnpm/bun in a PR.
- **Supabase CLI** — required to apply migrations to a Supabase project. Install with `brew install supabase/tap/supabase` (macOS/Linux) or see the [official docs](https://supabase.com/docs/guides/cli).
- **A Supabase project** — either a free-tier hosted project or a local stack via `supabase start`. You'll need its URL, anon key, and service-role key.

## First-time setup

1. **Fork and clone** the repo (external contributors), or clone directly if you have write access:

   ```bash
   git clone https://github.com/siropkin/budi-cloud.git
   cd budi-cloud
   ```

2. **Install dependencies** with the lockfile (do not use plain `npm install` for setup — it can drift the lockfile):

   ```bash
   npm ci
   ```

3. **Configure environment variables**:

   ```bash
   cp .env.local.example .env.local
   ```

   Then fill in the keys from your Supabase project's _Settings → API_ page:

   | Variable                        | Where it's used      | Notes                                                              |
   | ------------------------------- | -------------------- | ------------------------------------------------------------------ |
   | `NEXT_PUBLIC_SUPABASE_URL`      | Browser + server     | Public project URL.                                                |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser + server     | Public anon key.                                                   |
   | `SUPABASE_SERVICE_ROLE_KEY`     | **Server-side only** | Never commit, never expose to the client. Powers the admin client. |

   All three are required to run the dashboard against a real database.

4. **Apply migrations to your Supabase project**. The schema lives in `supabase/migrations/` and must be applied in order. From a clean Supabase project:

   ```bash
   supabase login                                  # one-time
   supabase link --project-ref <your-project-ref>  # link this checkout to your project
   supabase db push --include-all                  # apply every migration in supabase/migrations/
   ```

   Do **not** paste migrations into the Supabase SQL editor by hand — schema applied out-of-band drifts from the migration history and breaks future deploys. See the migrations note in [`SOUL.md`](SOUL.md#dev-notes) for the recovery procedure if you ever need it.

5. **Run the app**:

   ```bash
   npm run dev
   ```

   Open <http://localhost:3000> and sign in. The dashboard lives under `/dashboard/*`.

## Day-to-day commands

| Command                 | What it does                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`           | Start the Next.js dev server with hot reload.                                  |
| `npm run build`         | Production build — fails on type errors, broken imports, missing env at build. |
| `npm run start`         | Serve the production build (run `npm run build` first).                        |
| `npm test`              | Run the Vitest suite once.                                                     |
| `npm run test:coverage` | Run tests with coverage; respects the floor in `vitest.config.ts`.             |
| `npm run lint`          | ESLint (Next.js config).                                                       |
| `npm run typecheck`     | `tsc --noEmit` — strict type check across the whole project.                   |
| `npm run format`        | Apply Prettier to the working tree.                                            |
| `npm run format:check`  | Verify formatting — what CI runs.                                              |

Before pushing, run the same four gates CI runs:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test
```

If any of these fail in CI, the PR is blocked.

## Pull request conventions

- **Branch off `main`.** No long-lived feature branches.
- **One concern per PR.** Easier to review, easier to revert.
- **Squash-merge title format**: `type(scope): subject` — this is how it shows up in `git log` on `main`. Examples from recent history:
  - `docs(soul): reconcile pages list and DAL path with current code`
  - `tests(ingest): pin /v1/ingest 200/401/422/429 contract matrix`
  - `refactor(dal): split src/lib/dal.ts by surface`
  - `fix(api): 401 ingest/whoami/status when caller's org was deleted`

  Common types: `feat`, `fix`, `refactor`, `docs`, `tests`, `chore`. Common scopes mirror the surface (`dashboard`, `ingest`, `sessions`, `dal`, `api`, `soul`, …). Keep the subject under ~70 chars.

- **PR description** should answer _why_, not just _what_ — the diff already shows the what. Link the issue (`Closes #NNN`).
- **Keep `package-lock.json` in sync** with any dependency changes.

## What NOT to upload

The cloud is bound by a strict privacy contract — see [ADR-0083](https://github.com/siropkin/budi/blob/main/docs/adr/0083-cloud-ingest-identity-and-privacy-contract.md) in the main repo for the full text.

The cloud receives **pre-aggregated daily rollups and session summaries** — numeric metrics only. The following must **never** be added to ingest tables, API payloads, or stored anywhere in this service:

- Prompts, AI responses, or any conversational content
- Source code or diffs
- File paths
- Email addresses or any other PII beyond the org-membership identity
- Raw daemon payloads
- Tag values (the daemon hashes them locally)

If a new feature requires uploading anything in that list, **stop and re-read ADR-0083** — the answer is almost always to do the work locally in the daemon and only send the aggregate. Privacy regressions block merge.

## Reporting issues

- **Bugs and feature requests** — open an issue in this repo with steps to reproduce.
- **Security issues** — please do _not_ open a public issue; email the maintainer listed in the repo profile.

## Where to look next

- [`README.md`](README.md) — product overview, ecosystem links.
- [`SOUL.md`](SOUL.md) — architecture, directory layout, server-actions-vs-route-handlers rule, where new components go.
- [`supabase/migrations/`](supabase/migrations/) — schema history.
- [ADR-0083](https://github.com/siropkin/budi/blob/main/docs/adr/0083-cloud-ingest-identity-and-privacy-contract.md) — privacy contract (in the main `budi` repo).
- [ADR-0086](https://github.com/siropkin/budi/blob/main/docs/adr/0086-extraction-boundaries.md) — extraction boundaries between the four repos.

Thanks for contributing!
