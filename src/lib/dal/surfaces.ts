import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type BudiUser,
  type DateRange,
  type ScopeOptions,
  getVisibleDeviceIds,
  normalizeSurfaces,
} from "./types";

export interface SurfaceCost {
  surface: string;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Cost share by surface for the "Spend by Surface" card on the dashboard
 * (#187 part 2). Manager sees full org; member sees own devices only
 * (ADR-0083 §6). `options.scopedUserId` further narrows a manager view to a
 * single teammate; `options.surfaces` (from the chip) further narrows the
 * surfaces aggregated over — useful for the "show only `vscode` and
 * `cursor`" comparison.
 *
 * Returned rows include `unknown` whenever a device has rollups from a
 * pre-bump daemon, matching the issue acceptance ("rows from pre-bump
 * daemons display as `unknown` and remain in the all-surfaces aggregation").
 * The empty-state for single-surface orgs (one bar, full width) is the
 * caller's call — we always return whatever is present in the data.
 */
export async function getCostBySurface(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<SurfaceCost[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_cost_by_surface", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as SurfaceCostRow[])
    .map((r) => ({
      surface: r.surface,
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    }))
    .filter((s) => s.cost_cents > 0 || s.input_tokens + s.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface SurfaceCostRow {
  surface: string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

/**
 * Distinct surfaces with at least one rollup row visible to the viewer.
 * Powers the `<SurfaceFilter>` chip's options (#187 part 1) — drawn from
 * data so the day a JetBrains daemon first syncs the chip picks up
 * `jetbrains` automatically; no hardcoded enum to keep in sync with core.
 *
 * Deliberately not range-scoped: a surface that appeared in the org's
 * history but not in the current period still belongs in the chip so the
 * "filter to JetBrains" path remains usable after the team migrates off it.
 * `unknown` is included when present so a manager investigating "rows
 * without a surface tag" can still drill in.
 */
export async function getKnownSurfaces(
  user: BudiUser,
  options?: ScopeOptions
): Promise<string[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_known_surfaces", {
    p_device_ids: deviceIds,
  });
  if (error) throw error;

  return ((data ?? []) as { surface: string }[])
    .map((r) => r.surface)
    .filter((s) => typeof s === "string" && s.length > 0);
}
