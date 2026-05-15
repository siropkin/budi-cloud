#!/usr/bin/env bash
# Fail PRs that add a `CREATE TABLE public.x` without a matching `GRANT ... ON public.x`.
# Background: Supabase flips the Data API default on 2026-10-30 — after that
# date, new public-schema tables are invisible to supabase-js / PostgREST /
# GraphQL until grants are issued (PostgREST returns 42501). See issue #306
# and the migrations section of SOUL.md.
set -euo pipefail

shopt -s nocasematch

migrations_dir="$(dirname "$0")/migrations"
missing=0

for f in "$migrations_dir"/*.sql; do
  [ -e "$f" ] || continue

  # Pull every `public.<name>` that appears as the target of CREATE TABLE.
  # Handles `CREATE TABLE`, `CREATE TABLE IF NOT EXISTS`, and quoted identifiers.
  tables=$(grep -ioE 'create[[:space:]]+table[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?public\.[a-zA-Z0-9_"]+' "$f" \
    | sed -E 's/.*public\.//; s/"//g' \
    | sort -u || true)

  for t in $tables; do
    if ! grep -iqE "grant[[:space:]]+[^;]+on[[:space:]]+(table[[:space:]]+)?public\.${t}([[:space:]]|;|$)" "$f"; then
      echo "::error file=$f::CREATE TABLE public.${t} has no matching GRANT in the same migration (see SOUL.md / issue #306)"
      missing=1
    fi
  done
done

if [ "$missing" -ne 0 ]; then
  echo
  echo "One or more new public-schema tables are missing GRANTs. Add the boilerplate from SOUL.md before merging."
  exit 1
fi

echo "All public-schema CREATE TABLE statements have matching GRANTs."
