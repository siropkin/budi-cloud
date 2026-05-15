/**
 * Documented dependency order for wiping a workspace's data.
 *
 * The actual delete is executed server-side by the Postgres function
 * `delete_workspace_cascade` (migration `025_rename_org_to_workspace.sql`,
 * originally `024_delete_org_cascade.sql`) so the whole thing runs as one
 * transaction — see #276 for the bug where six independent
 * `supabase.from(...).delete()` statements silently swallowed FK violations
 * and left the workspace half-deleted. This constant is the canonical record
 * of the SQL function's order; the tests pin it against the function body so
 * a change to one without the other fails loudly.
 *
 * Lives in its own module because `workspace.ts` is a `"use server"` file
 * and those can only export async functions — exporting a plain constant
 * from there crashes the server action with "A 'use server' file can only
 * export async functions."
 */
export const WORKSPACE_CASCADE_ORDER = [
  "session_summaries",
  "daily_rollups",
  "devices",
  "workspace_price_list_rows",
  "workspace_price_lists",
  "workspace_pricing_defaults",
  "recalculation_runs",
  "invite_tokens",
  "users",
  "workspaces",
] as const;
