import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Whether the workspace has at least one `active` price list. Powers the
 * conditional rendering of the savings strip and the Effective/List toggle
 * on the Overview (#235): when no list is active, the daemon-uploaded cost
 * is the only number that exists, so there is nothing to compare against
 * and the UI stays clean. Until the upload UI ships (#232) this returns
 * `false` for every workspace — and the Overview keeps rendering exactly as
 * it does today, which is the acceptance criterion for migration 019.
 */
export async function getWorkspaceHasActivePriceList(
  workspaceId: string
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspace_price_lists")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return data !== null;
}

/**
 * Page of `recalculation_runs` rows for the Settings → Pricing audit-history
 * tab (#733). Each row is one invocation of the recalc engine (#728); the
 * rows are immutable. We support a simple offset window because the table is
 * small (one row per admin click) and the surface paginates 50 at a time.
 *
 * `status` narrows by `recalculation_runs.status`. Pass `null` to include
 * every run. The page also returns `total` so the UI can size the pager
 * without a second round-trip — `count: "exact"` is cheap on this table.
 */
export interface RecalculationRunRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  scopeFromDate: string | null;
  scopeToDate: string | null;
  priceListIds: number[];
  rowsProcessed: number | null;
  rowsChanged: number | null;
  beforeTotalCents: number | null;
  afterTotalCents: number | null;
  triggeredBy: string | null;
}

export async function getRecalculationRuns(
  workspaceId: string,
  options: { status: string | null; limit: number; offset: number }
): Promise<{ rows: RecalculationRunRow[]; total: number }> {
  const admin = createAdminClient();
  let query = admin
    .from("recalculation_runs")
    .select(
      "id, started_at, finished_at, status, scope_from_date, scope_to_date, price_list_ids, rows_processed, rows_changed, before_total_cents, after_total_cents, triggered_by",
      { count: "exact" }
    )
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .range(options.offset, options.offset + options.limit - 1);
  if (options.status) query = query.eq("status", options.status);

  const { data, count, error } = await query;
  if (error) throw error;

  const rows: RecalculationRunRow[] = (data ?? []).map((r) => ({
    id: r.id as number,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    status: (r.status as string) ?? "",
    scopeFromDate: (r.scope_from_date as string | null) ?? null,
    scopeToDate: (r.scope_to_date as string | null) ?? null,
    priceListIds: ((r.price_list_ids as number[] | null) ?? []).map(Number),
    rowsProcessed: r.rows_processed == null ? null : Number(r.rows_processed),
    rowsChanged: r.rows_changed == null ? null : Number(r.rows_changed),
    beforeTotalCents:
      r.before_total_cents == null ? null : Number(r.before_total_cents),
    afterTotalCents:
      r.after_total_cents == null ? null : Number(r.after_total_cents),
    triggeredBy: (r.triggered_by as string | null) ?? null,
  }));
  return { rows, total: count ?? 0 };
}
