import "server-only";
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

export interface BudiUser {
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
  /**
   * Narrow every aggregation to one or more surfaces (#187), e.g. `['vscode']`
   * for the JetBrains-vs-VS Code rollout question. `null`, `undefined`, or an
   * empty array all mean "no filter" — the dashboard's `<SurfaceFilter>` chip
   * collapses an all-deselected state back to the default rather than zeroing
   * the page out. The breakdown RPCs treat `NULL p_surfaces` and an empty
   * array identically (015) so callers don't have to remember which sentinel
   * to pass.
   */
  surfaces?: string[] | null;
}

export type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Normalize a `ScopeOptions.surfaces` value to the wire shape the RPCs want.
 * Returns `null` for any "no filter" case; otherwise a deduped, non-empty
 * array. Centralized so callers can pass a raw URL-derived value without
 * branching on undefined / [] themselves.
 */
export function normalizeSurfaces(
  raw: string[] | null | undefined
): string[] | null {
  if (!raw || raw.length === 0) return null;
  const trimmed = raw.map((s) => s.trim()).filter((s) => s.length > 0);
  if (trimmed.length === 0) return null;
  return Array.from(new Set(trimmed));
}

/**
 * Wrap a value in PostgREST's quoted-literal syntax (`"..."`). Escapes
 * embedded `\` and `"` per PostgREST's docs so the filter tree always parses
 * as a single leaf — never as a stray delimiter that opens a new branch in
 * the parent expression. Used by `getSessions` when expanding a composite
 * `(started_at, session_id) < cursor` compare into a `.or()` disjunction.
 */
export function postgrestQuoteLiteral(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

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
export async function getVisibleDeviceIds(
  admin: AdminClient,
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
  admin: AdminClient,
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
