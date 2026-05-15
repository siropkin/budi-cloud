import { createAdminClient } from "@/lib/supabase/admin";

/**
 * #233: TypeScript wrapper around the Postgres `recalculate_effective_cost`
 * function (migration 021). The math lives in SQL — see ADR-0094 §7 and the
 * migration's header for the resolution + idempotency contracts. This wrapper
 * only translates between camelCase callers (server actions, the nightly
 * pg_cron shim, the "Recompute from <date>" admin button) and the Postgres
 * `recalc_summary` composite the function returns.
 *
 * Only the service-role admin client can invoke the RPC: the migration
 * REVOKE-s every other role. Manager gating happens above this layer in the
 * server action — by the time control reaches here we trust the caller.
 */

export type RecalcSummary = {
  /** `recalculation_runs.id` for the audit row this run wrote. */
  runId: number;
  /** Daily-rollup + session rows visited in scope. */
  rowsProcessed: number;
  /** Rows whose `_effective` cost actually changed (idempotent → 0). */
  rowsChanged: number;
  /** Sum of `cost_cents_effective` over the scope before the recalc. */
  beforeTotalCents: number;
  /** Sum of `cost_cents_effective` over the scope after the recalc. */
  afterTotalCents: number;
};

export type RecalcInput = {
  workspaceId: string;
  /** Inclusive lower bound on `daily_rollups.bucket_day`. */
  fromDate: string; // YYYY-MM-DD
  /** Inclusive upper bound. */
  toDate: string; // YYYY-MM-DD
  /** Optional `users.id` of the manager who kicked this run off. */
  triggeredBy?: string | null;
};

type RecalcRpcRow = {
  run_id: number | string;
  rows_processed: number | string;
  rows_changed: number | string;
  before_total_cents: number | string;
  after_total_cents: number | string;
};

/**
 * Invoke the `recalculate_effective_cost(org, from, to, by)` SQL function and
 * normalize its `recalc_summary` composite into a JS object.
 *
 * The function returns a single composite row; supabase-js surfaces composite
 * returns as either the object itself or a one-element array depending on
 * driver version, so handle both shapes defensively.
 */
export async function recalculateEffectiveCost(
  input: RecalcInput
): Promise<RecalcSummary> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("recalculate_effective_cost", {
    p_workspace_id: input.workspaceId,
    p_from_date: input.fromDate,
    p_to_date: input.toDate,
    p_triggered_by: input.triggeredBy ?? null,
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as RecalcRpcRow | null;
  if (!row) {
    throw new Error("recalculate_effective_cost returned no row");
  }

  return {
    runId: Number(row.run_id),
    rowsProcessed: Number(row.rows_processed),
    rowsChanged: Number(row.rows_changed),
    beforeTotalCents: Number(row.before_total_cents),
    afterTotalCents: Number(row.after_total_cents),
  };
}
