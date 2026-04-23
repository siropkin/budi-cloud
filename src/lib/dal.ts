import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
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
 */
export async function getOverviewStats(user: BudiUser, range: DateRange) {
  const admin = createAdminClient();

  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) {
    return {
      totalCostCents: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalMessages: 0,
      totalSessions: 0,
    };
  }

  const { data: rollups } = await admin
    .from("daily_rollups")
    .select(
      "cost_cents, input_tokens, output_tokens, message_count, cache_creation_tokens, cache_read_tokens"
    )
    .in("device_id", deviceIds)
    .gte("bucket_day", range.from)
    .lte("bucket_day", range.to)
    // Defeat the default PostgREST max-rows cap so Overview and Team sum the
    // same complete row set (#15).
    .limit(100_000);

  const { count: sessionCount } = await admin
    .from("session_summaries")
    .select("*", { count: "exact", head: true })
    .in("device_id", deviceIds)
    .gte("started_at", range.from)
    .lte("started_at", range.to + "T23:59:59Z");

  const totals = (rollups ?? []).reduce(
    (acc, r) => ({
      totalCostCents: acc.totalCostCents + Number(r.cost_cents),
      totalInputTokens: acc.totalInputTokens + Number(r.input_tokens),
      totalOutputTokens: acc.totalOutputTokens + Number(r.output_tokens),
      totalMessages: acc.totalMessages + r.message_count,
    }),
    {
      totalCostCents: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalMessages: 0,
    }
  );

  return { ...totals, totalSessions: sessionCount ?? 0 };
}

/**
 * Get daily cost activity for charts.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 */
export async function getDailyActivity(user: BudiUser, range: DateRange) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data: rollups } = await admin
    .from("daily_rollups")
    .select(
      "bucket_day, input_tokens, output_tokens, cost_cents, message_count"
    )
    .in("device_id", deviceIds)
    .gte("bucket_day", range.from)
    .lte("bucket_day", range.to)
    .order("bucket_day");

  // Aggregate by day
  const byDay = new Map<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cost_cents: number;
      message_count: number;
    }
  >();
  for (const r of rollups ?? []) {
    const existing = byDay.get(r.bucket_day) ?? {
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      message_count: 0,
    };
    existing.input_tokens += Number(r.input_tokens);
    existing.output_tokens += Number(r.output_tokens);
    existing.cost_cents += Number(r.cost_cents);
    existing.message_count += r.message_count;
    byDay.set(r.bucket_day, existing);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, data]) => ({ bucket_day: day, ...data }));
}

/**
 * Earliest day (`YYYY-MM-DD`) with a rollup for any device visible to the
 * viewer, or `null` if the org has never synced anything. Used to materialize
 * the `?days=all` sentinel into a concrete `from` before hitting the
 * range-scoped queries so their signatures stay unchanged.
 */
export async function getEarliestActivity(
  user: BudiUser
): Promise<string | null> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
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
const UNASSIGNED_USER_ID = "__unassigned__";

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

  const { data: rollups } = await admin
    .from("daily_rollups")
    .select("device_id, cost_cents")
    .in("device_id", deviceIds)
    .gte("bucket_day", range.from)
    .lte("bucket_day", range.to)
    // Defeat the default PostgREST max-rows cap so we sum every row instead
    // of a silently-truncated subset.
    .limit(100_000);

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

  type Bucket = { id: string; name: string; cost_cents: number };
  const byUser = new Map<string, Bucket>();
  for (const r of rollups ?? []) {
    const ownerId = deviceToUser.get(r.device_id as string);
    const bucketId =
      ownerId && visibleOwnerIds.has(ownerId) ? ownerId : UNASSIGNED_USER_ID;
    const cost = Number(r.cost_cents);
    const existing = byUser.get(bucketId);
    if (existing) {
      existing.cost_cents += cost;
    } else {
      byUser.set(bucketId, {
        id: bucketId,
        name:
          bucketId === UNASSIGNED_USER_ID
            ? "Unassigned"
            : (userMeta.get(bucketId) ?? bucketId.slice(0, 8)),
        cost_cents: cost,
      });
    }
  }

  return Array.from(byUser.values())
    .filter((u) => u.cost_cents > 0)
    .sort((a, b) => {
      // Keep "Unassigned" at the end regardless of its magnitude.
      if (a.id === UNASSIGNED_USER_ID) return 1;
      if (b.id === UNASSIGNED_USER_ID) return -1;
      return b.cost_cents - a.cost_cents;
    });
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
  range: DateRange
): Promise<DeviceCost[]> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data: rollups } = await admin
    .from("daily_rollups")
    .select("device_id, cost_cents")
    .in("device_id", deviceIds)
    .gte("bucket_day", range.from)
    .lte("bucket_day", range.to)
    // Match the cap used elsewhere so we never silently truncate the sum.
    .limit(100_000);

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

  const costByDevice = new Map<string, number>();
  for (const r of rollups ?? []) {
    const id = r.device_id as string;
    costByDevice.set(id, (costByDevice.get(id) ?? 0) + Number(r.cost_cents));
  }

  // Surface every visible device — including zero-cost ones — so a brand-new
  // daemon shows up the moment it registers, even before it has pushed a
  // rollup. That matters most during the "linked, waiting for first sync"
  // gap covered by FirstSyncInProgressBanner on Overview.
  const result: DeviceCost[] = [];
  for (const [id, meta] of deviceMeta) {
    result.push({
      id,
      label: meta.label,
      owner_name:
        user.role === "manager" ? (ownerLookup.get(meta.user_id) ?? null) : null,
      last_seen: meta.last_seen,
      cost_cents: costByDevice.get(id) ?? 0,
    });
  }

  return result.sort((a, b) => b.cost_cents - a.cost_cents);
}

/**
 * Get cost breakdown by model.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 */
export async function getCostByModel(user: BudiUser, range: DateRange) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data: rollups } = await admin
    .from("daily_rollups")
    .select("provider, model, cost_cents")
    .in("device_id", deviceIds)
    .gte("bucket_day", range.from)
    .lte("bucket_day", range.to);

  const byModel = new Map<
    string,
    { provider: string; model: string; cost_cents: number }
  >();
  for (const r of rollups ?? []) {
    const key = `${r.provider}:${r.model}`;
    const existing = byModel.get(key);
    if (existing) {
      existing.cost_cents += Number(r.cost_cents);
    } else {
      byModel.set(key, {
        provider: r.provider,
        model: r.model,
        cost_cents: Number(r.cost_cents),
      });
    }
  }

  return Array.from(byModel.values())
    .filter((m) => m.cost_cents > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

/**
 * Get cost breakdown by repo.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 */
export async function getCostByRepo(user: BudiUser, range: DateRange) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data: rollups } = await admin
    .from("daily_rollups")
    .select("repo_id, cost_cents")
    .in("device_id", deviceIds)
    .gte("bucket_day", range.from)
    .lte("bucket_day", range.to);

  const byRepo = new Map<string, number>();
  for (const r of rollups ?? []) {
    byRepo.set(r.repo_id, (byRepo.get(r.repo_id) ?? 0) + Number(r.cost_cents));
  }

  return Array.from(byRepo.entries())
    .map(([repo_id, cost_cents]) => ({ repo_id, cost_cents }))
    .filter((r) => r.cost_cents > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

/**
 * Get cost breakdown by branch.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 */
export async function getCostByBranch(user: BudiUser, range: DateRange) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data: rollups } = await admin
    .from("daily_rollups")
    .select("repo_id, git_branch, cost_cents")
    .in("device_id", deviceIds)
    .gte("bucket_day", range.from)
    .lte("bucket_day", range.to);

  const byBranch = new Map<
    string,
    { repo_id: string; git_branch: string; cost_cents: number }
  >();
  for (const r of rollups ?? []) {
    const key = `${r.repo_id}:${r.git_branch}`;
    const existing = byBranch.get(key);
    if (existing) {
      existing.cost_cents += Number(r.cost_cents);
    } else {
      byBranch.set(key, {
        repo_id: r.repo_id,
        git_branch: r.git_branch,
        cost_cents: Number(r.cost_cents),
      });
    }
  }

  return Array.from(byBranch.values())
    .filter((b) => b.cost_cents > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

/**
 * Get cost breakdown by ticket.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 */
export async function getCostByTicket(user: BudiUser, range: DateRange) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data: rollups } = await admin
    .from("daily_rollups")
    .select("ticket, cost_cents")
    .in("device_id", deviceIds)
    .gte("bucket_day", range.from)
    .lte("bucket_day", range.to)
    .not("ticket", "is", null);

  const byTicket = new Map<string, number>();
  for (const r of rollups ?? []) {
    if (r.ticket) {
      byTicket.set(
        r.ticket,
        (byTicket.get(r.ticket) ?? 0) + Number(r.cost_cents)
      );
    }
  }

  return Array.from(byTicket.entries())
    .map(([ticket, cost_cents]) => ({ ticket, cost_cents }))
    .filter((t) => t.cost_cents > 0)
    .sort((a, b) => b.cost_cents - a.cost_cents);
}

/**
 * Get sessions list.
 * Manager sees full org; member sees own devices only (ADR-0083 §6).
 */
export async function getSessions(user: BudiUser, range: DateRange) {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) return [];

  const { data: sessions } = await admin
    .from("session_summaries")
    .select("*")
    .in("device_id", deviceIds)
    .gte("started_at", range.from)
    .lte("started_at", range.to + "T23:59:59Z")
    .order("started_at", { ascending: false })
    .limit(100);

  return sessions ?? [];
}

/**
 * Sync freshness snapshot for the viewer.
 *
 * Used by the dashboard header to render a "Last synced X ago" indicator and
 * to distinguish *not linked yet* from *linked, waiting for first sync* from
 * *stalled*.
 *
 * - `deviceCount` is the number of daemons the viewer can see. Zero means the
 *   account exists on cloud but no local daemon has ever called `/v1/ingest`
 *   with this API key yet — the "not linked yet" state.
 * - `lastSeenAt` is the most recent `devices.last_seen` across the visible
 *   devices. It advances on every successful ingest, even when the payload
 *   contains zero rollups, so it's the authoritative "is the daemon talking
 *   to us" signal.
 * - `lastRollupAt` is the most recent `daily_rollups.synced_at` across the
 *   visible devices. If `deviceCount > 0` but `lastRollupAt` is null, the
 *   daemon is linked but hasn't pushed any usage rows yet — that's the
 *   "initial sync in progress / no data yet" state.
 */
export async function getSyncFreshness(user: BudiUser): Promise<{
  deviceCount: number;
  lastSeenAt: string | null;
  lastRollupAt: string | null;
}> {
  const admin = createAdminClient();
  const deviceIds = await getVisibleDeviceIds(admin, user);
  if (deviceIds.length === 0) {
    return { deviceCount: 0, lastSeenAt: null, lastRollupAt: null };
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

  return {
    deviceCount: deviceIds.length,
    lastSeenAt: (lastSeenRow?.last_seen as string | null) ?? null,
    lastRollupAt: (lastRollupRow?.synced_at as string | null) ?? null,
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
 */
async function getVisibleDeviceIds(
  admin: ReturnType<typeof createAdminClient>,
  user: BudiUser
): Promise<string[]> {
  if (user.role === "manager") {
    return getOrgDeviceIds(admin, user.org_id!);
  }
  // Member: own devices only
  const { data: devices } = await admin
    .from("devices")
    .select("id")
    .eq("user_id", user.id);
  return (devices ?? []).map((d) => d.id);
}

async function getOrgDeviceIds(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string
): Promise<string[]> {
  const { data: users } = await admin
    .from("users")
    .select("id")
    .eq("org_id", orgId);

  if (!users?.length) return [];

  const { data: devices } = await admin
    .from("devices")
    .select("id")
    .in(
      "user_id",
      users.map((u) => u.id)
    );

  return (devices ?? []).map((d) => d.id);
}
