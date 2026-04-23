/**
 * Dependency order for wiping an org's data.
 *
 * None of the FKs in `001_ingest_schema.sql` declare `ON DELETE CASCADE`, so
 * we delete leaves first. This list is reused by the tests to document and
 * pin the expected sequence.
 *
 * Lives in its own module because `org.ts` is a `"use server"` file and those
 * can only export async functions — exporting a plain constant from there
 * crashes the server action with "A 'use server' file can only export async
 * functions."
 */
export const ORG_CASCADE_ORDER = [
  "session_summaries",
  "daily_rollups",
  "devices",
  "invite_tokens",
  "users",
  "orgs",
] as const;
