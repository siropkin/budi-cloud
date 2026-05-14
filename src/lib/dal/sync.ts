import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BudiUser } from "./types";

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
