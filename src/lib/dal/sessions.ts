import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type AdminClient,
  type BudiUser,
  type DateRange,
  type ScopeOptions,
  getVisibleDeviceIds,
  normalizeSurfaces,
  postgrestQuoteLiteral,
} from "./types";

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

  const surfaces = normalizeSurfaces(options?.surfaces);
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

  if (surfaces) query = query.in("surface", surfaces);

  if (cursor) {
    // Composite tuple compare: (started_at, session_id) < cursor.
    // PostgREST has no native row-constructor compare, so we expand to the
    // logically-equivalent disjunction.
    //
    // Both values are wrapped in PostgREST's quoted-literal syntax — without
    // the quoting, a `session_id` containing filter-tree metacharacters (`,`,
    // `(`, `)`) would inject extra top-level conditions into the disjunction,
    // breaking the cursor invariant. Decoding already rejects those shapes
    // (#176), but we quote here too so a direct DAL caller can't bypass it.
    const startedAt = postgrestQuoteLiteral(cursor.startedAt);
    const sessionId = postgrestQuoteLiteral(cursor.sessionId);
    query = query.or(
      `started_at.lt.${startedAt},and(started_at.eq.${startedAt},session_id.lt.${sessionId})`
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
  admin: AdminClient,
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
  // Dual cost columns (#231): `_effective` is what the dashboard renders;
  // `_ingested` is the daemon-uploaded value before any team-pricing recalc
  // was applied. Until the recalc engine ships (#233) the two are equal; the
  // "list-vs-effective delta + savings" widget (#235) will surface the gap.
  total_cost_cents_effective: number | string;
  total_cost_cents_ingested: number | string;
  // Per-session main model (#140). NULL for rows ingested before the daemon
  // started emitting `primary_model`, and for sessions with zero scored
  // messages — render as em-dash in those cases.
  main_model: string | null;
  // Free-form session title (#255). Sources include the daemon's parsed
  // `session_title` tag (siropkin/budi#779) — typically an IntelliJ project
  // name (`Verkada-Web`) or session-type label (`chat-agent`). NULL for
  // pre-8.5.0 rows and for surfaces that don't emit a title; render as a
  // muted dash in those cases.
  title: string | null;
  // Resolved owner label for the device this session ran on (#138). Only
  // populated for manager viewers; null for member viewers (every row is
  // theirs) and for sessions whose device→user mapping cannot be resolved.
  // Not a column on `session_summaries` — joined in by the DAL via
  // `attachOwners`.
  owner_name?: string | null;
  // Surface dimension (#187). Pre-#187 rows backfill to the literal
  // `'unknown'`, so the Sessions table column never has a null hole — the
  // dashboard treats `unknown` as its own bucket and filters/displays
  // accordingly.
  surface: string;
  // The schema also has `vital_*` columns (006_session_vitals.sql) but the
  // daemon has never populated them, so the dashboard stopped reading them in
  // #141. Reintroduce typed fields here once budi-core ships vitals on the
  // ingest envelope.
}

/**
 * Fetch a single session by `(device_id, session_id)` for the session-detail
 * page (#99). Returns `null` when the session does not exist *or* when it
 * exists but is not visible to the viewer (manager: anywhere in the workspace;
 * member: only on a device they own — same scoping as `getSessions`). The
 * "not visible" → `null` branch deliberately collapses with "not found" so
 * the URL parameter cannot be used to probe whether a foreign-workspace session
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
 * Fetch a single session by `session_id` alone, scoped to the viewer's
 * visible devices. Powers the deep-link entry point at
 * `/dashboard/sessions/<id>` without `?device=` (#202): a manager pasting a
 * session URL from chat / a ticket should land on the page even though the
 * URL doesn't carry the device half of the composite PK.
 *
 * Returns `null` when no row matches OR when more than one device in the
 * viewer's scope happens to share the same `session_id` (extraordinarily
 * rare for UUID daemons, but the ambiguous case must collapse with
 * not-found rather than guess and silently render the wrong row).
 *
 * Existence is collapsed with visibility — same privacy contract as
 * `getSessionDetail`: a foreign-workspace session never reveals its existence
 * via response shape or timing differences. Callers should `notFound()`
 * on a `null` return.
 */
export async function getSessionDetailBySessionId(
  user: BudiUser,
  sessionId: string
): Promise<SessionRow | null> {
  const admin = createAdminClient();
  const visibleDeviceIds = await getVisibleDeviceIds(admin, user);
  if (visibleDeviceIds.length === 0) return null;

  const { data } = await admin
    .from("session_summaries")
    .select("*")
    .in("device_id", visibleDeviceIds)
    .eq("session_id", sessionId)
    // Cap at 2 so the ambiguous-match branch can short-circuit without
    // pulling an unbounded result set when the daemon-emitted session_id
    // happens to be a non-UUID string that appears across many devices.
    .limit(2);

  const rows = (data ?? []) as SessionRow[];
  if (rows.length !== 1) return null;
  const [enriched] = await attachOwners(admin, user, rows);
  return enriched ?? rows[0]!;
}
