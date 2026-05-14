import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type BudiUser,
  type DateRange,
  type ScopeOptions,
  getVisibleDeviceIds,
  normalizeSurfaces,
} from "./types";

/**
 * Get overview stats visible to the current user.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 *
 * Aggregation runs server-side via `dashboard_overview_stats` (#92) so the
 * sums are independent of any PostgREST row cap — `getOverviewStats` and
 * every breakdown query agree on the same row set regardless of org size.
 *
 * The session count is filtered by the same `bucket_day` calendar range as
 * the rollup totals (#155). Pre-#155 the count used a precise TIMESTAMPTZ
 * window over `started_at`, which excluded sessions with NULL `started_at`
 * and was narrower than the rollup window — on `?days=1` that asymmetry
 * was enough to collapse the previous-period count to zero while every
 * other card on the same row showed real period-over-period deltas.
 */
export interface OverviewStats {
  totalCostCents: number;
  totalCostCentsIngested: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalMessages: number;
  totalSessions: number;
}

export async function getOverviewStats(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
): Promise<OverviewStats> {
  const admin = createAdminClient();

  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) {
    return {
      totalCostCents: 0,
      totalCostCentsIngested: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalMessages: 0,
      totalSessions: 0,
    };
  }

  const { data, error } = await admin.rpc("dashboard_overview_stats", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  const row = (data?.[0] ?? null) as OverviewRow | null;
  // Pre-#235 the RPC didn't surface `_ingested`; default to the effective
  // total so a deployment that ships the dashboard ahead of migration 020
  // simply reports zero savings rather than crashing on `undefined`.
  const effective: number = Number(row?.total_cost_cents ?? 0);
  const ingested: number = Number(row?.total_cost_cents_ingested ?? effective);
  return {
    totalCostCents: effective,
    totalCostCentsIngested: ingested,
    totalInputTokens: Number(row?.total_input_tokens ?? 0),
    totalOutputTokens: Number(row?.total_output_tokens ?? 0),
    totalMessages: Number(row?.total_messages ?? 0),
    totalSessions: Number(row?.total_sessions ?? 0),
  };
}

interface OverviewRow {
  total_cost_cents: number | string;
  total_cost_cents_ingested?: number | string;
  total_input_tokens: number | string;
  total_output_tokens: number | string;
  total_messages: number | string;
  total_sessions: number | string;
}

/**
 * Get daily cost activity for charts.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 *
 * Aggregation runs server-side via `dashboard_daily_activity` (#92). Prior to
 * #92 this client-side reduce silently dropped the *oldest* days at the left
 * edge of the chart once the predicate matched > 100,000 rollup rows.
 */
export async function getDailyActivity(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_daily_activity", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as DailyActivityRow[])
    .map((r) => {
      const effective = Number(r.cost_cents);
      return {
        bucket_day: r.bucket_day,
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cost_cents: effective,
        // Pre-#235 RPC has no `_ingested` column — collapse to effective so
        // the toggle's "hide when ingested == effective everywhere" check
        // stays correct and we never paint a fake savings delta.
        cost_cents_ingested: Number(r.cost_cents_ingested ?? effective),
        message_count: Number(r.message_count),
      };
    })
    .sort((a, b) => a.bucket_day.localeCompare(b.bucket_day));
}

interface DailyActivityRow {
  bucket_day: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cost_cents: number | string;
  cost_cents_ingested?: number | string;
  message_count: number | string;
}

/**
 * Day-of-week × hour-of-day session counts for the Overview heatmap (#150).
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 *
 * Buckets are computed in the **viewer's IANA timezone** (server-side via
 * `dashboard_activity_heatmap`) so a US/Pacific viewer's "5pm peak" sits at
 * `hour=17` instead of drifting to UTC's `hour=00`. Falls back to UTC when
 * the viewer's TZ cookie is missing — same fallback `dateRangeFromDays`
 * uses, so the bucketing TZ matches the range-window TZ.
 *
 * Returns 0..168 rows (one per non-empty `(dow, hour)` cell). Empty cells
 * are absent from the result; the client fills them with zero rather than
 * paying for a `generate_series` cross join on every page load.
 */
export async function getActivityHeatmap(
  user: BudiUser,
  range: DateRange,
  timeZone: string | null,
  options?: ScopeOptions
): Promise<HeatmapCell[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_activity_heatmap", {
    p_device_ids: deviceIds,
    p_started_from: range.startedAtFrom,
    p_started_to: range.startedAtTo,
    p_time_zone: timeZone ?? "UTC",
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;

  return ((data ?? []) as HeatmapRow[]).map((r) => ({
    dow: Number(r.dow),
    hour: Number(r.hour),
    session_count: Number(r.session_count),
    cost_cents: Number(r.cost_cents),
  }));
}

export interface HeatmapCell {
  dow: number;
  hour: number;
  session_count: number;
  cost_cents: number;
}

interface HeatmapRow {
  dow: number | string;
  hour: number | string;
  session_count: number | string;
  cost_cents: number | string;
}

/**
 * Earliest day (`YYYY-MM-DD`) with a rollup for any device visible to the
 * viewer, or `null` if the org has never synced anything. Used to materialize
 * the `?days=all` sentinel into a concrete `from` before hitting the
 * range-scoped queries so their signatures stay unchanged.
 */
export async function getEarliestActivity(
  user: BudiUser,
  options?: ScopeOptions
): Promise<string | null> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return null;

  const surfaces = normalizeSurfaces(options?.surfaces);
  let query = admin
    .from("daily_rollups")
    .select("bucket_day")
    .in("device_id", deviceIds);
  if (surfaces) query = query.in("surface", surfaces);
  const { data } = await query
    .order("bucket_day", { ascending: true })
    .limit(1)
    .maybeSingle();

  return (data?.bucket_day as string | null) ?? null;
}

/** Synthetic user id used to group rollups whose owner we can't surface. */
export const UNASSIGNED_USER_ID = "__unassigned__";

/**
 * Get cost breakdown by user/device.
 * Manager sees all users; member sees only their own cost (ADR-0083 §6).
 *
 * Rollups that resolve to a visible user are grouped by that user. Any cost
 * left over (devices whose owner isn't in the viewer's visible set, or
 * rollups with no matching device row) is surfaced as an `Unassigned` row,
 * mirroring how `Cost by Project` on the Repos page already handles
 * unattributed data. This guarantees
 *
 *     getOverviewStats.totalCostCents === sum(getCostByUser[...].cost_cents)
 *
 * for the same (user, range), fixing the Overview/Team reconciliation gap
 * described in #15.
 */
export async function getCostByUser(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();

  // Use the identical device set as `getOverviewStats` so the two pages
  // agree on the denominator.
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  // Aggregate rollups server-side (#92). The owner mapping lives in the small,
  // bounded `devices` + `users` tables, so the secondary join still happens in
  // JS without risk of row-cap truncation.
  const { data: rows, error } = await admin.rpc("dashboard_cost_by_device", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
    p_surfaces: normalizeSurfaces(options?.surfaces),
  });
  if (error) throw error;
  const deviceCostRows = (rows ?? []) as DeviceCostRow[];

  const { data: devices } = await admin
    .from("devices")
    .select("id, user_id")
    .in("id", deviceIds);

  const deviceToUser = new Map<string, string>();
  for (const d of devices ?? []) {
    deviceToUser.set(d.id as string, d.user_id as string);
  }

  const ownerIds = Array.from(new Set(deviceToUser.values()));
  const { data: ownerUsers } =
    ownerIds.length > 0
      ? await admin
          .from("users")
          .select("id, display_name, email, org_id")
          .in("id", ownerIds)
      : { data: [] as UserLookup[] };

  // Which owner IDs should surface by name to this viewer?
  //   - Manager: every owner in their org
  //   - Member:  only themselves; anything else collapses into Unassigned
  const visibleOwnerIds = new Set<string>(
    user.role === "manager"
      ? (ownerUsers ?? [])
          .filter((u) => u.org_id === user.org_id)
          .map((u) => u.id)
      : [user.id]
  );

  const userMeta = new Map<string, string>();
  for (const u of ownerUsers ?? []) {
    userMeta.set(u.id, u.display_name || u.email || u.id.slice(0, 8));
  }

  type Bucket = {
    id: string;
    name: string;
    cost_cents: number;
    input_tokens: number;
    output_tokens: number;
  };
  const byUser = new Map<string, Bucket>();
  for (const r of deviceCostRows) {
    const ownerId = deviceToUser.get(r.device_id);
    const bucketId =
      ownerId && visibleOwnerIds.has(ownerId) ? ownerId : UNASSIGNED_USER_ID;
    const cost = Number(r.cost_cents);
    const inTok = Number(r.input_tokens ?? 0);
    const outTok = Number(r.output_tokens ?? 0);
    const existing = byUser.get(bucketId);
    if (existing) {
      existing.cost_cents += cost;
      existing.input_tokens += inTok;
      existing.output_tokens += outTok;
    } else {
      byUser.set(bucketId, {
        id: bucketId,
        name:
          bucketId === UNASSIGNED_USER_ID
            ? "Unassigned"
            : (userMeta.get(bucketId) ?? bucketId.slice(0, 8)),
        cost_cents: cost,
        input_tokens: inTok,
        output_tokens: outTok,
      });
    }
  }

  return Array.from(byUser.values())
    .filter((u) => u.cost_cents > 0 || u.input_tokens + u.output_tokens > 0)
    .sort((a, b) => {
      // Keep "Unassigned" at the end regardless of its magnitude.
      if (a.id === UNASSIGNED_USER_ID) return 1;
      if (b.id === UNASSIGNED_USER_ID) return -1;
      return b.cost_cents - a.cost_cents;
    });
}

interface DeviceCostRow {
  device_id: string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

interface UserLookup {
  id: string;
  display_name: string | null;
  email: string | null;
  org_id: string | null;
}
