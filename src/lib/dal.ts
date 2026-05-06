import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface DateRange {
  /** Inclusive lower bound in the **viewer's local TZ** (`YYYY-MM-DD`). */
  from: string;
  /** Inclusive upper bound in the **viewer's local TZ** (`YYYY-MM-DD`). */
  to: string;
  /**
   * UTC `bucket_day` lower bound for the daemon's UTC-bucketed
   * `daily_rollups` table. Derived from `from 00:00:00` in the viewer's TZ
   * so the SQL filter captures every UTC bucket overlapping the local-TZ
   * window — including the previous UTC day for users west of UTC, where
   * yesterday-evening-local activity lands in "today's" UTC bucket. See
   * siropkin/budi-cloud#78.
   */
  bucketFrom: string;
  /** UTC `bucket_day` upper bound; mirror of `bucketFrom`. */
  bucketTo: string;
  /**
   * Inclusive lower bound for `session_summaries.started_at`, an ISO-8601
   * UTC instant (e.g. `2026-04-26T07:00:00.000Z`). Sessions are precise
   * timestamps so we filter on the actual instant rather than a calendar
   * day, avoiding the same TZ-vs-UTC drift that motivates `bucketFrom`.
   */
  startedAtFrom: string;
  /** Inclusive upper bound for `session_summaries.started_at`. */
  startedAtTo: string;
}

interface BudiUser {
  id: string;
  org_id: string | null;
  role: string;
  api_key: string;
  display_name: string | null;
  email: string | null;
}

/**
 * Optional scoping options for the dashboard breakdown queries.
 *
 * `scopedUserId` narrows the visible-device set to a single teammate's devices
 * — the manager-only header filter introduced in #80. It is silently ignored
 * for member viewers (their visibility is already self-only per ADR-0083 §6)
 * and silently falls back to the org-wide set when the id is unknown or
 * belongs to another org, mirroring the existing role branch in
 * `getVisibleDeviceIds`. We deliberately do not surface a 4xx so an attacker
 * can't enumerate other-org user ids by probing this parameter.
 */
export interface ScopeOptions {
  scopedUserId?: string | null;
}

/**
 * Get the current budi user and verify they have an org.
 * Uses admin client because the auth→users mapping needs to bypass RLS
 * during the initial lookup.
 */
export async function getCurrentUser(): Promise<BudiUser | null> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("users")
    .select("id, org_id, role, api_key, display_name, email")
    .eq("id", authUser.id)
    .single();

  return data;
}

/**
 * Get overview stats visible to the current user.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 *
 * Aggregation runs server-side via `dashboard_overview_stats` (#92) so the
 * sums are independent of any PostgREST row cap — `getOverviewStats` and
 * every breakdown query agree on the same row set regardless of org size.
 */
export async function getOverviewStats(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();

  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) {
    return {
      totalCostCents: 0,
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
    p_started_from: range.startedAtFrom,
    p_started_to: range.startedAtTo,
  });
  if (error) throw error;

  const row = (data?.[0] ?? null) as OverviewRow | null;
  return {
    totalCostCents: Number(row?.total_cost_cents ?? 0),
    totalInputTokens: Number(row?.total_input_tokens ?? 0),
    totalOutputTokens: Number(row?.total_output_tokens ?? 0),
    totalMessages: Number(row?.total_messages ?? 0),
    totalSessions: Number(row?.total_sessions ?? 0),
  };
}

interface OverviewRow {
  total_cost_cents: number | string;
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
  });
  if (error) throw error;

  return ((data ?? []) as DailyActivityRow[])
    .map((r) => ({
      bucket_day: r.bucket_day,
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cost_cents: Number(r.cost_cents),
      message_count: Number(r.message_count),
    }))
    .sort((a, b) => a.bucket_day.localeCompare(b.bucket_day));
}

interface DailyActivityRow {
  bucket_day: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cost_cents: number | string;
  message_count: number | string;
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

  const { data } = await admin
    .from("daily_rollups")
    .select("bucket_day")
    .in("device_id", deviceIds)
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
export async function getCostByUser(user: BudiUser, range: DateRange) {
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
  range: DateRange
): Promise<TeamActivityDay[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_team_activity_by_day", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
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

interface UserLookup {
  id: string;
  display_name: string | null;
  email: string | null;
  org_id: string | null;
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
 * Manager sees every device in the org; member sees only their own (ADR-0083 §6).
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
  });
  if (error) throw error;

  return ((data ?? []) as ModelCostRow[])
    .map((r) => ({
      provider: r.provider,
      model: r.model,
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    }))
    .filter((m) => m.cost_cents > 0 || m.input_tokens + m.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface ModelCostRow {
  provider: string;
  model: string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

/**
 * Get cost breakdown by repo.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 */
export async function getCostByRepo(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_cost_by_repo", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
  });
  if (error) throw error;

  return ((data ?? []) as RepoCostRow[])
    .map((r) => ({
      repo_id: r.repo_id,
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    }))
    .filter((r) => r.cost_cents > 0 || r.input_tokens + r.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface RepoCostRow {
  repo_id: string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

/**
 * Get cost breakdown by branch.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 */
export async function getCostByBranch(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_cost_by_branch", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
  });
  if (error) throw error;

  return ((data ?? []) as BranchCostRow[])
    .map((r) => ({
      repo_id: r.repo_id,
      git_branch: r.git_branch,
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    }))
    .filter((b) => b.cost_cents > 0 || b.input_tokens + b.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface BranchCostRow {
  repo_id: string;
  git_branch: string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

/**
 * Get cost breakdown by ticket.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 */
export async function getCostByTicket(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions
) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return [];

  const { data, error } = await admin.rpc("dashboard_cost_by_ticket", {
    p_device_ids: deviceIds,
    p_bucket_from: range.bucketFrom,
    p_bucket_to: range.bucketTo,
  });
  if (error) throw error;

  return ((data ?? []) as TicketCostRow[])
    .map((r) => ({
      ticket: r.ticket,
      cost_cents: Number(r.cost_cents),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    }))
    .filter((t) => t.cost_cents > 0 || t.input_tokens + t.output_tokens > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

interface TicketCostRow {
  ticket: string;
  cost_cents: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
}

/**
 * Cursor for `getSessions` pagination — encodes the row at the boundary of the
 * current page. The composite `(started_at, session_id)` shape gives a stable
 * walk even when two sessions share a `started_at` (rare but real once cursor
 * sync re-emits a batch with the same instant): the SQL filter
 * `(started_at, session_id) < cursor` keeps the strict ordering and never
 * skips or duplicates a tied row.
 *
 * The dashboard URL serializes this as `?cursor=<base64url(JSON)>` so a
 * session_id containing punctuation never collides with a delimiter (#85).
 */
export interface SessionsCursor {
  startedAt: string;
  sessionId: string;
}

/** Default page size for the Sessions table — matches the UI's pager. */
export const SESSIONS_PAGE_SIZE = 50;

/**
 * Get a single page of sessions ordered by `(started_at desc, session_id desc)`.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 * `options.scopedUserId` further narrows a manager view to a single teammate.
 *
 * Pagination is cursor-based on `(started_at, session_id)`. Sessions are
 * immutable once written so the cursor is stable across reloads — no offset
 * skew under concurrent writes, no expensive count query required to know if
 * another page exists. We fetch `pageSize + 1` rows so `hasMore` falls out of
 * the result-set size; the extra row is dropped before returning.
 *
 * History: prior to #85 this returned the most recent 100 rows with no
 * pagination, silently truncating the visible Sessions history to whatever
 * fit in those 100 rows (~9 days for a high-volume org). The
 * `Recent Sessions (100+)` title was the only hint that anything older
 * existed. Cursor pagination replaces both.
 */
export async function getSessions(
  user: BudiUser,
  range: DateRange,
  options?: ScopeOptions,
  pagination?: { pageSize?: number; cursor?: SessionsCursor | null }
): Promise<{ rows: SessionRow[]; nextCursor: SessionsCursor | null }> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user, options);
  if (deviceIds.length === 0) return { rows: [], nextCursor: null };

  const pageSize = pagination?.pageSize ?? SESSIONS_PAGE_SIZE;
  const cursor = pagination?.cursor ?? null;

  let query = admin
    .from("session_summaries")
    .select("*")
    .in("device_id", deviceIds)
    .gte("started_at", range.startedAtFrom)
    .lte("started_at", range.startedAtTo)
    .order("started_at", { ascending: false })
    // Tie-breaker: without a secondary sort key, two rows with the same
    // `started_at` could appear on either side of a cursor boundary across
    // requests, causing rows to skip or duplicate as the user paginates.
    .order("session_id", { ascending: false })
    .limit(pageSize + 1);

  if (cursor) {
    // Composite tuple compare: (started_at, session_id) < cursor.
    // PostgREST has no native row-constructor compare, so we expand to the
    // logically-equivalent disjunction.
    query = query.or(
      `started_at.lt.${cursor.startedAt},and(started_at.eq.${cursor.startedAt},session_id.lt.${cursor.sessionId})`
    );
  }

  const { data } = await query;
  const fetched = (data ?? []) as SessionRow[];
  const hasMore = fetched.length > pageSize;
  const trimmed = hasMore ? fetched.slice(0, pageSize) : fetched;
  const rows = await attachOwners(admin, user, trimmed);
  const tail = rows[rows.length - 1];
  const nextCursor =
    hasMore && tail
      ? { startedAt: tail.started_at, sessionId: tail.session_id }
      : null;

  return { rows, nextCursor };
}

/**
 * Resolve owner display labels for a batch of session rows. Manager-only:
 * member viewers already know every row is theirs (#138), so we leave
 * `owner_name` null and skip the device→user→identity joins entirely.
 *
 * Falls back through `display_name → email → id-prefix` so a freshly-invited
 * teammate without a profile name still renders something a manager can match
 * to a person in the team list. Mirrors the lookup already proven out in
 * `getCostByDevice` so the two surfaces label the same teammate identically.
 */
async function attachOwners(
  admin: ReturnType<typeof createAdminClient>,
  user: BudiUser,
  rows: SessionRow[]
): Promise<SessionRow[]> {
  if (user.role !== "manager" || rows.length === 0) return rows;

  const deviceIds = Array.from(new Set(rows.map((r) => r.device_id)));
  const { data: devices } = await admin
    .from("devices")
    .select("id, user_id")
    .in("id", deviceIds);
  const deviceToUser = new Map<string, string>();
  for (const d of devices ?? []) {
    deviceToUser.set(d.id as string, d.user_id as string);
  }

  const ownerIds = Array.from(new Set(deviceToUser.values()));
  if (ownerIds.length === 0) return rows;

  const { data: owners } = await admin
    .from("users")
    .select("id, display_name, email")
    .in("id", ownerIds);
  const ownerLookup = new Map<string, string>(
    (owners ?? []).map((u) => [
      u.id as string,
      (u.display_name as string | null) ||
        (u.email as string | null) ||
        (u.id as string).slice(0, 8),
    ])
  );

  return rows.map((r) => {
    const ownerId = deviceToUser.get(r.device_id);
    return {
      ...r,
      owner_name: ownerId ? (ownerLookup.get(ownerId) ?? null) : null,
    };
  });
}

export interface SessionRow {
  device_id: string;
  session_id: string;
  provider: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  repo_id: string | null;
  git_branch: string | null;
  ticket: string | null;
  message_count: number;
  total_input_tokens: number | string;
  total_output_tokens: number | string;
  total_cost_cents: number | string;
  // Per-session main model (#140). NULL for rows ingested before the daemon
  // started emitting `primary_model`, and for sessions with zero scored
  // messages — render as em-dash in those cases.
  main_model: string | null;
  // Resolved owner label for the device this session ran on (#138). Only
  // populated for manager viewers; null for member viewers (every row is
  // theirs) and for sessions whose device→user mapping cannot be resolved.
  // Not a column on `session_summaries` — joined in by the DAL via
  // `attachOwners`.
  owner_name?: string | null;
  // The schema also has `vital_*` columns (006_session_vitals.sql) but the
  // daemon has never populated them, so the dashboard stopped reading them in
  // #141. Reintroduce typed fields here once budi-core ships vitals on the
  // ingest envelope.
}

/**
 * Fetch a single session by `(device_id, session_id)` for the session-detail
 * page (#99). Returns `null` when the session does not exist *or* when it
 * exists but is not visible to the viewer (manager: anywhere in the org;
 * member: only on a device they own — same scoping as `getSessions`). The
 * "not visible" → `null` branch deliberately collapses with "not found" so
 * the URL parameter cannot be used to probe whether a foreign-org session
 * exists.
 */
export async function getSessionDetail(
  user: BudiUser,
  deviceId: string,
  sessionId: string
): Promise<SessionRow | null> {
  const admin = createAdminClient();
  const visibleDeviceIds = await getVisibleDeviceIds(admin, user);
  if (!visibleDeviceIds.includes(deviceId)) return null;

  const { data } = await admin
    .from("session_summaries")
    .select("*")
    .eq("device_id", deviceId)
    .eq("session_id", sessionId)
    .maybeSingle();

  const row = (data as SessionRow | null) ?? null;
  if (!row) return null;
  const [enriched] = await attachOwners(admin, user, [row]);
  return enriched ?? row;
}

/**
 * Sync freshness snapshot for the viewer.
 *
 * Used by the dashboard header to render a "Last synced X ago" indicator and
 * to distinguish *not linked yet* from *linked, waiting for first sync* from
 * *stalled*. Always scoped to the **viewer's own devices**, regardless of
 * role — the badge answers "is *my* daemon healthy" and a manager whose own
 * daemon has been silent for hours should see a stale badge even if a
 * teammate's daemon synced 3 minutes ago (#74). The org-wide "who's stale?"
 * view lives on `/dashboard/devices`, which is the right surface for a
 * manager chasing down a teammate's broken daemon.
 *
 * - `deviceCount` is the number of daemons the viewer themselves has linked.
 *   Zero means the viewer's account exists on cloud but they haven't run
 *   `budi cloud init` yet — the "not linked yet" state. (The same field
 *   drives the `LinkDaemonBanner` on the overview, so a manager who hasn't
 *   linked their own daemon still gets the prompt even if teammates have.)
 * - `lastSeenAt` is the most recent `devices.last_seen` across the viewer's
 *   own devices. It advances on every successful ingest, even when the
 *   payload contains zero rollups, so it's the authoritative "is *my*
 *   daemon talking to us" signal.
 * - `lastRollupAt` is the most recent `daily_rollups.synced_at` across the
 *   viewer's own devices. If `deviceCount > 0` but `lastRollupAt` is null,
 *   the viewer is linked but hasn't pushed any usage rows yet — that's the
 *   "initial sync in progress / no data yet" state.
 * - `lastSessionAt` is the most recent `session_summaries.started_at` across
 *   the viewer's own devices. The two ingest streams (rollups and sessions)
 *   travel in the same envelope but are independent rows on the cloud side,
 *   so a daemon-side regression can drop sessions while still landing
 *   rollups. The header badge cross-checks the two watermarks so the
 *   divergence surfaces in the badge instead of silently emptying the
 *   Sessions page (#84).
 */
export async function getSyncFreshness(user: BudiUser): Promise<{
  deviceCount: number;
  lastSeenAt: string | null;
  lastRollupAt: string | null;
  lastSessionAt: string | null;
}> {
  const admin = createAdminClient();
  const { data: ownDevices } = await admin
    .from("devices")
    .select("id")
    .eq("user_id", user.id);
  const deviceIds = (ownDevices ?? []).map((d) => d.id as string);
  if (deviceIds.length === 0) {
    return {
      deviceCount: 0,
      lastSeenAt: null,
      lastRollupAt: null,
      lastSessionAt: null,
    };
  }

  const { data: lastSeenRow } = await admin
    .from("devices")
    .select("last_seen")
    .in("id", deviceIds)
    .order("last_seen", { ascending: false })
    .limit(1)
    .single();

  // `.maybeSingle()` because the "linked but no rollups yet" first-run state
  // legitimately returns zero rows (covered by `FirstSyncInProgressBanner`).
  // `.single()` would emit a PGRST116 / HTTP 406 row in production logs on
  // every freshly-linked-no-data render even though the call site already
  // tolerates `data: null` (see #22).
  const { data: lastRollupRow } = await admin
    .from("daily_rollups")
    .select("synced_at")
    .in("device_id", deviceIds)
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Probe `started_at` rather than `synced_at`: the user-facing Sessions
  // page sorts by `started_at`, and a "session that never closes" daemon
  // bug would keep upserting the same row's `synced_at` while no new
  // sessions land, masking the divergence we want to detect.
  const { data: lastSessionRow } = await admin
    .from("session_summaries")
    .select("started_at")
    .in("device_id", deviceIds)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    deviceCount: deviceIds.length,
    lastSeenAt: (lastSeenRow?.last_seen as string | null) ?? null,
    lastRollupAt: (lastRollupRow?.synced_at as string | null) ?? null,
    lastSessionAt: (lastSessionRow?.started_at as string | null) ?? null,
  };
}

/**
 * Get org members list.
 */
export async function getOrgMembers(orgId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("users")
    .select("id, display_name, email, role, created_at")
    .eq("org_id", orgId)
    .order("created_at");

  return data ?? [];
}

// --- Helpers ---

/**
 * Get device IDs visible to the current user.
 * Per ADR-0083 §6:
 *   - Manager: sees all devices in the org
 *   - Member: sees only their own devices
 *
 * `options.scopedUserId` (manager-only, #80) narrows the result further to a
 * single teammate's devices. If the id is missing, unknown, or belongs to
 * another org we silently fall back to the org-wide set rather than 4xxing,
 * so the URL parameter cannot be used to probe other orgs' user ids. Members
 * already collapse to themselves and ignore the option entirely.
 */
async function getVisibleDeviceIds(
  admin: ReturnType<typeof createAdminClient>,
  user: BudiUser,
  options?: ScopeOptions
): Promise<string[]> {
  if (user.role === "manager") {
    return getOrgDeviceIds(admin, user.org_id!, options?.scopedUserId ?? null);
  }
  // Member: own devices only — `scopedUserId` is intentionally ignored.
  const { data: devices } = await admin
    .from("devices")
    .select("id")
    .eq("user_id", user.id);
  return (devices ?? []).map((d) => d.id);
}

async function getOrgDeviceIds(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  scopedUserId: string | null
): Promise<string[]> {
  const { data: users } = await admin
    .from("users")
    .select("id")
    .eq("org_id", orgId);

  if (!users?.length) return [];

  const orgUserIds = users.map((u) => u.id as string);
  // Narrow to a single teammate when the manager picked one — but only if
  // they're actually in the manager's org. Anything else collapses back to
  // org-wide so an out-of-org id can't leak the existence of another org.
  const userIds =
    scopedUserId && orgUserIds.includes(scopedUserId)
      ? [scopedUserId]
      : orgUserIds;

  const { data: devices } = await admin
    .from("devices")
    .select("id")
    .in("user_id", userIds);

  return (devices ?? []).map((d) => d.id);
}
