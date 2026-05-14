import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type BudiUser,
  type DateRange,
  type ScopeOptions,
  getVisibleDeviceIds,
  normalizeSurfaces,
} from "./types";

export interface ModelActivityDay {
  bucket_day: string;
  active_models: number;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Daily series of distinct active models + total cost for the Models page
 * (#147). Active = the `(provider, model)` pair has any rollup row in the
 * bucket. Manager sees the full org; member sees own devices only
 * (ADR-0083 §6). When the manager's `UserFilter` is engaged the series is
 * narrowed to that teammate's devices so it stays consistent with the
 * per-model bar chart on the same page.
 *
 * Days with no rollup activity simply don't appear in the result; the chart
 * components decide whether to interpolate or render a gap.
 */
export async function getModelActivityByDay(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<ModelActivityDay[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_model_activity_by_day", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as ModelActivityRow[])
    .map((r) => ({
      bucket_day: r.bucket_day,
      active_models: Number(r.active_models),
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    }))
    .sort((a, b) => a.bucket_day.localeCompare(b.bucket_day));
}

interface ModelActivityRow {
  bucket_day: string;
  active_models: number | string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

/**
 * Get cost breakdown by model.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 */
export async function getCostByModel(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_cost_by_model", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as ModelCostRow[])
    .map((r) => {
      const effective = Number(r.cost_cents);
      return {
        provider: r.provider,
        model: r.model,
        cost_cents: effective,
        // Pre-022 the RPC didn't surface `_ingested`; fall back to effective so
        // the "List / Effective" tooltip stays hidden on deployments running
        // ahead of migration 022 rather than rendering "$X / $X" everywhere.
        cost_cents_ingested: Number(r.cost_cents_ingested ?? effective),
        input_tokens: Number(r.input_tokens ?? 0),
        output_tokens: Number(r.output_tokens ?? 0),
      };
    })
    .filter((m) => m.cost_cents > 0 || m.input_tokens + m.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface ModelCostRow {
  provider: string;
  model: string;
  cost_cents: number | string;
  cost_cents_ingested?: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}
