# budi-cloud

Cloud dashboard and ingest API for [budi](https://github.com/siropkin/budi). Provides team-wide AI cost visibility across users, repos, models, branches, and tickets.

## Overview

- **Dashboard** at `app.getbudi.dev` — overview, team, models, repos, sessions, settings pages
- **Ingest API** — receives pre-aggregated daily rollups and session summaries from the budi daemon
- **Auth** — Supabase Auth (GitHub, Google, magic link) with org-based access control

Built with Next.js 16, Supabase, and Tailwind CSS.

## What data the cloud receives

The budi daemon pushes **pre-aggregated daily rollups and session summaries** — numeric metrics only. The cloud never receives prompts, code, AI responses, file paths, email addresses, raw payloads, or tag values. There is no "full upload" mode.

What syncs: token counts, costs, model names, hashed repo IDs, branch names, ticket IDs, session durations, and message counts.

See [ADR-0083](https://github.com/siropkin/budi/blob/main/docs/adr/0083-cloud-ingest-identity-and-privacy-contract.md) for the complete privacy contract.

## Transport and trust model

- **HTTPS only** — the daemon refuses to sync over plain HTTP
- **Push-only** — the daemon initiates all connections; the cloud never reaches back to developer machines. There is no webhook, pull, or remote command channel
- **Idempotent** — sync uses UPSERT semantics with deterministic keys; retries are safe and produce no duplicates

## Team model (cloud alpha)

The cloud alpha supports small teams (1–20 developers):

| Aspect          | Detail                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Roles**       | `manager` (view all org data, manage members) and `member` (sync data, view own data)                                |
| **Granularity** | Daily aggregates; no per-message, per-hour, or real-time views                                                       |
| **Retention**   | 90 days                                                                                                              |
| **Multi-org**   | Not supported in v1 — one user belongs to one org                                                                    |
| **SSO / SAML**  | Not supported in v1 — API key auth for daemon sync, Supabase Auth (GitHub, Google, magic link) for the web dashboard |

## Auth

- **Web dashboard**: Supabase Auth with GitHub, Google, and magic link sign-in
- **Daemon sync**: API key (`budi_<key>`) in `Authorization: Bearer` header. Users link a local daemon to their cloud account with `budi cloud init --api-key <key>`; the daemon then owns the on-disk key storage.
- **Ingest API**: `POST /v1/ingest` receives the sync payload; `GET /v1/ingest/status` returns watermark and sync health

## Setup

1. Copy `.env.local.example` to `.env.local` and fill in your Supabase project keys
2. Install dependencies and run:

```bash
npm ci
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000)

## Build

```bash
npm run build
```

## Deployment

The app is deployed to Vercel and connects to a Supabase project. Database migrations live in `supabase/migrations/`.

## Ecosystem

- **[budi](https://github.com/siropkin/budi)** — Rust daemon + CLI (pushes data via cloud sync)
- **[budi-cursor](https://github.com/siropkin/budi-cursor)** — VS Code/Cursor extension

## License

[MIT](LICENSE)
