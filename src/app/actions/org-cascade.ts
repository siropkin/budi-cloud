/**
 * Documented dependency order for wiping an org's data.
 *
 * The actual delete is executed server-side by the Postgres function
 * `delete_org_cascade` (migration `024_delete_org_cascade.sql`) so the whole
 * thing runs as one transaction — see #276 for the bug where six independent
 * `supabase.from(...).delete()` statements silently swallowed FK violations
 * and left the org half-deleted. This constant is the canonical record of
 * the SQL function's order; the tests pin it against the function body so a
 * change to one without the other fails loudly.
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
  "org_price_list_rows",
  "org_price_lists",
  "org_pricing_defaults",
  "recalculation_runs",
  "invite_tokens",
  "users",
  "orgs",
] as const;
