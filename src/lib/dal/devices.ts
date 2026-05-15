import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type BudiUser,
  type DateRange,
  type ScopeOptions,
  getVisibleDeviceIds,
  normalizeSurfaces,
} from "./types";

export interface DeviceActivityDay {
  bucket_day: string;
  active_devices: number;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Daily series of distinct active devices + total cost for the Devices page
 * (#145). Active = the device wrote any rollup row for that bucket. Manager
 * sees the full org; member sees own devices only (ADR-0083 §6). When the
 * manager's `UserFilter` is engaged the series is narrowed to that teammate's
 * devices so it stays consistent with the per-device bar chart on the same
 * page.
 *
 * Days with no rollup activity simply don't appear in the result; the chart
 * components decide whether to interpolate or render a gap.
 */
export async function getDeviceActivityByDay(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<DeviceActivityDay[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_device_activity_by_day", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as DeviceActivityRow[])
    .map((r) => ({
      bucket_day: r.bucket_day,
      active_devices: Number(r.active_devices),
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    }))
    .sort((a, b) => a.bucket_day.localeCompare(b.bucket_day));
}

interface DeviceActivityRow {
  bucket_day: string;
  active_devices: number | string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

export interface DeviceCost {
  id: string;
  label: string | null;
  owner_name: string | null;
  last_seen: string | null;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Get cost breakdown by device.
 * Manager sees every device in the workspace; member sees only their own (ADR-0083 §6).
 *
 * Reuses `getVisibleDeviceIds` so the device set — and therefore the rollup
 * sum — matches Overview / Team for the same (user, range). For any visible
 * user, the Overview total equals the sum of `cost_cents` returned here.
 *
 * `owner_name` is populated in the manager view so the table can disambiguate
 * two laptops labelled `"laptop"` sitting under different owners. For members
 * it stays `null` — the member already knows every row is theirs and the
 * extra column would just be noise.
 */
export async function getCostByDevice(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<DeviceCost[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  // Aggregate rollups server-side (#92). The cap-truncation that #15 / #90
  // chased lives entirely on the rollup-row pull, so removing that pull is
  // the fix; the secondary metadata reads below are bounded by org device
  // count and never exceed the 1k PostgREST default.
  const { data: rows, error } = await admin.rpc("dashboard_cost_by_device", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;
  const rollups = (rows ?? []) as DeviceCostRow[];

  const { data: devices } = await admin
    .from("devices")
    .select("id, label, user_id, last_seen")
    .in("id", deviceIds);

  const deviceMeta = new Map<
    string,
    { label: string | null; user_id: string; last_seen: string | null }
  >();
  for (const d of devices ?? []) {
    deviceMeta.set(d.id as string, {
      label: (d.label as string | null) ?? null,
      user_id: d.user_id as string,
      last_seen: (d.last_seen as string | null) ?? null,
    });
  }

  let ownerLookup = new Map<string, string>();
  if (user.role === "manager") {
    const ownerIds = Array.from(
      new Set(Array.from(deviceMeta.values()).map((d) => d.user_id))
    );
    if (ownerIds.length > 0) {
      const { data: owners } = await admin
        .from("users")
        .select("id, display_name, email")
        .in("id", ownerIds);
      ownerLookup = new Map(
        (owners ?? []).map((u) => [
          u.id as string,
          (u.display_name as string | null) ||
            (u.email as string | null) ||
            (u.id as string).slice(0, 8),
        ])
      );
    }
  }

  // The RPC already aggregates by device_id, so each row is a (device, sum)
  // tuple — no further reduction needed.
  const totalsByDevice = new Map<
    string,
    { cost_cents: number; input_tokens: number; output_tokens: number }
  >();
  for (const r of rollups) {
    totalsByDevice.set(r.device_id, {
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    });
  }

  // Surface every visible device — including zero-cost ones — so a brand-new
  // daemon shows up the moment it registers, even before it has pushed a
  // rollup. That matters most during the "linked, waiting for first sync"
  // gap covered by FirstSyncInProgressBanner on Overview.
  const result: DeviceCost[] = [];
  for (const [id, meta] of deviceMeta) {
    const totals = totalsByDevice.get(id);
    result.push({
      id,
      label: meta.label,
      owner_name:
        user.role === "manager"
          ? (ownerLookup.get(meta.user_id) ?? null)
          : null,
      last_seen: meta.last_seen,
      cost_cents: totals?.cost_cents ?? 0,
      input_tokens: totals?.input_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
    });
  }

  return result.sort((a, b) => b.cost_cents - a.cost_cents);
}

interface DeviceCostRow {
  device_id: string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}
