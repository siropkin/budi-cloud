# budi-cloud

Cloud dashboard and ingest API for [budi](https://github.com/siropkin/budi). Provides team-wide AI cost visibility across users, repos, models, branches, and tickets.

## Overview

- **Dashboard** at `app.getbudi.dev` — overview, team, models, repos, sessions, settings pages
- **Ingest API** — receives pre-aggregated daily rollups and session summaries from the budi daemon
- **Auth** — Supabase Auth (GitHub, Google, magic link) with org-based access control

Built with Next.js 16, Supabase, and Tailwind CSS.

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
