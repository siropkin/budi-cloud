import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type BudiUser,
  type DateRange,
  type ScopeOptions,
  getVisibleDeviceIds,
  normalizeSurfaces,
} from "./types";

export interface TeamActivityDay {
  bucket_day: string;
  active_members: number;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Daily series of distinct active members + total cost for the Team page (#127).
 * Active = any device the user owns wrote a rollup row for that bucket.
 * Manager sees the full org; member sees own devices only (ADR-0083 §6) — i.e.
 * a member's chart will read 0 or 1 every day, which is the same self-only
 * answer the rest of the page already gives them.
 *
 * Days with no rollup activity simply don't appear in the result; the chart
 * components decide whether to interpolate or render a gap.
 */
export async function getTeamActivityByDay(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<TeamActivityDay[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_team_activity_by_day", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as TeamActivityRow[])
    .map((r) => ({
      bucket_day: r.bucket_day,
      active_members: Number(r.active_members),
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    }))
    .sort((a, b) => a.bucket_day.localeCompare(b.bucket_day));
}

interface TeamActivityRow {
  bucket_day: string;
  active_members: number | string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}
