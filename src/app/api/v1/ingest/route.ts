import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  clientIp,
  hashKey,
  rateLimit,
  rateLimitResponse,
} from "@/lib/rate-limit";
import {
  buildRollupRows,
  buildSessionRows,
  summarizeEnvelope,
  validateIngestMetrics,
  type IngestDailyRollup,
  type IngestSessionSummary,
} from "@/app/api/v1/ingest/rows";

// ADR-0083 §7: Max body size 1 MiB
const MAX_BODY_BYTES = 1024 * 1024;

// #179: per-key/per-IP rate limit. Daemon ships hourly by default
// (ADR-0083 §7) plus retries, so 60/min comfortably covers a healthy fleet
// while still catching a runaway loop. Bumping this requires re-checking
// the daily_rollups insert pressure, not just a one-line edit.
const RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

const CURRENT_SCHEMA_VERSION = 1;

// Cap the stored label so a malformed envelope can't flood the devices table.
// 128 chars is comfortably above any sane hostname or user-chosen nickname.
const MAX_LABEL_LENGTH = 128;

// Per-org cap on auto-registered devices. The daemon ships one device row per
// machine, and even prolific orgs sit comfortably under this. The cap exists
// to make device-id squatting (#181) economically uninteresting: an attacker
// with a valid key can't pre-register an unbounded list of guessed ids.
const MAX_DEVICES_PER_ORG = 50;

// Accept any RFC-9562 UUID (versions 1–8, including v4/v7 the daemon ships).
// Rejecting non-UUID ids closes the squatting vector from #181: a caller can
// no longer auto-register an arbitrary, predictable string under their org.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SyncEnvelope {
  schema_version: number;
  device_id: string;
  org_id: string;
  synced_at: string;
  // User-controlled display name for this device. Daemon default is the OS
  // hostname, but the user can override (or blank) via `cloud.toml` — so this
  // is treated as an opaque string, not PII the cloud mandates. See the
  // privacy note in ADR-0083 §1 and the paired daemon ticket on siropkin/budi.
  label?: string | null;
  payload: {
    daily_rollups: IngestDailyRollup[];
    session_summaries: IngestSessionSummary[];
  };
}

/**
 * Interpret the envelope's `label` field:
 *   - key absent (undefined): don't touch the stored value — old daemon compat.
 *   - present but non-string / null: explicit clear → store `null`.
 *   - empty / whitespace-only: explicit clear → store `null`.
 *   - non-empty string: trim + cap at MAX_LABEL_LENGTH, store that.
 *
 * Returning `undefined` signals "no update"; `null` or a string signals a
 * write (so an empty or explicit-null envelope entry clears a stale label).
 */
function normalizeLabel(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_LABEL_LENGTH);
}

/**
 * Authenticate the request via Bearer token.
 * Returns the user row or null if auth fails.
 */
async function authenticateApiKey(
  supabase: ReturnType<typeof createAdminClient>,
  authHeader: string | null
) {
  if (!authHeader?.startsWith("Bearer ")) return null;

  const apiKey = authHeader.slice(7);
  if (!apiKey.startsWith("budi_")) return null;

  const { data, error } = await supabase
    .from("users")
    .select("id, org_id, role")
    .eq("api_key", apiKey)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Validate the sync envelope structure.
 * Returns an error message or null if valid.
 */
function validateEnvelope(body: SyncEnvelope): string | null {
  if (body.schema_version !== CURRENT_SCHEMA_VERSION) {
    return `Unsupported schema_version: ${body.schema_version}. Expected ${CURRENT_SCHEMA_VERSION}.`;
  }
  if (!body.device_id || typeof body.device_id !== "string") {
    return "Missing or invalid device_id";
  }
  if (!UUID_RE.test(body.device_id)) {
    return "device_id must be a UUID";
  }
  if (!body.org_id || typeof body.org_id !== "string") {
    return "Missing or invalid org_id";
  }
  if (!body.payload) {
    return "Missing payload";
  }
  if (!Array.isArray(body.payload.daily_rollups)) {
    return "payload.daily_rollups must be an array";
  }
  if (!Array.isArray(body.payload.session_summaries)) {
    return "payload.session_summaries must be an array";
  }
  // #178: reject the whole envelope on non-finite or negative numeric metrics
  // so a misbehaving daemon pauses (ADR-0083 §7) instead of silently
  // poisoning every aggregate that touches the row for the 90-day window.
  const metricError = validateIngestMetrics(
    body.payload.daily_rollups,
    body.payload.session_summaries
  );
  if (metricError) return metricError;
  return null;
}

/**
 * POST /v1/ingest
 *
 * Receives sync payload from daemon per ADR-0083 §7.
 * Auth: Authorization: Bearer budi_<key>
 * Body: sync envelope (ADR-0083 §2)
 * UPSERT semantics per ADR-0083 §5.
 */
export async function POST(request: NextRequest) {
  // --- Body size check ---
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return Response.json(
      { error: "Request body exceeds 1 MiB limit" },
      { status: 413 }
    );
  }

  // --- Pre-auth IP rate limit (#179) ---
  // Apply before the API-key lookup so a brute-force scan against `users.api_key`
  // can't spend our DB budget. A legitimate daemon hits this from a single IP
  // and stays well under the cap.
  const ipLimit = await rateLimit(`ingest:ip:${clientIp(request)}`, RATE_LIMIT);
  if (!ipLimit.success) return rateLimitResponse(ipLimit.retryAfterSeconds);

  // --- Auth ---
  const supabase = createAdminClient();
  const authHeader = request.headers.get("authorization");
  const user = await authenticateApiKey(supabase, authHeader);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Per-key rate limit (#179) ---
  // Authoritative limit for the authenticated path. Bucketed on a hash of the
  // key so the raw secret never lands in `rate_limits` rows.
  const keyLimit = await rateLimit(
    `ingest:key:${hashKey(authHeader!.slice(7))}`,
    RATE_LIMIT
  );
  if (!keyLimit.success) return rateLimitResponse(keyLimit.retryAfterSeconds);

  // --- Parse body ---
  let body: SyncEnvelope;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return Response.json(
        { error: "Request body exceeds 1 MiB limit" },
        { status: 413 }
      );
    }
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // --- Validate envelope ---
  const validationError = validateEnvelope(body);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 422 });
  }

  // --- Verify org ownership ---
  if (body.org_id !== user.org_id) {
    return Response.json(
      { error: "org_id does not match authenticated user's org" },
      { status: 401 }
    );
  }

  // --- Verify device belongs to user's org ---
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id, user_id")
    .eq("id", body.device_id)
    .single();

  const labelUpdate = normalizeLabel(body.label);
  const now = new Date().toISOString();

  if (deviceError || !device) {
    // #181: cap auto-registration per org so a single compromised key can't
    // bulk-squat device ids. Counting via a join through `users` keeps the
    // limit at the org level — multiple users in the same org share the cap.
    const { data: orgUserIds } = await supabase
      .from("users")
      .select("id")
      .eq("org_id", user.org_id);
    const userIds = (orgUserIds ?? []).map((u) => u.id as string);
    const { count: orgDeviceCount } = await supabase
      .from("devices")
      .select("id", { count: "exact", head: true })
      .in("user_id", userIds.length > 0 ? userIds : [user.id]);
    if ((orgDeviceCount ?? 0) >= MAX_DEVICES_PER_ORG) {
      return Response.json(
        {
          error: `Device cap reached: an org may auto-register at most ${MAX_DEVICES_PER_ORG} devices. Contact a manager to release unused ids.`,
        },
        { status: 429 }
      );
    }

    // Auto-register the device if it doesn't exist yet. `label` is persisted
    // here (when sent) so the Devices dashboard shows a recognisable name
    // from the very first sync rather than the truncated id fallback (#60).
    const { error: insertError } = await supabase.from("devices").insert({
      id: body.device_id,
      user_id: user.id,
      first_seen: now,
      last_seen: now,
      label: labelUpdate ?? null,
    });
    if (insertError) {
      console.error("Failed to register device:", insertError);
      return Response.json(
        { error: "Failed to register device" },
        { status: 500 }
      );
    }
  } else {
    // Verify device belongs to a user in the same org
    const { data: deviceOwner } = await supabase
      .from("users")
      .select("org_id")
      .eq("id", device.user_id)
      .single();

    if (!deviceOwner || deviceOwner.org_id !== user.org_id) {
      return Response.json(
        { error: "Device does not belong to your org" },
        { status: 401 }
      );
    }

    // Update last_seen. Only overwrite `label` when the envelope explicitly
    // carried one — an old daemon (key absent) must not clobber a label that
    // a newer daemon previously set on the same device.
    const patch: { last_seen: string; label?: string | null } = {
      last_seen: now,
    };
    if (labelUpdate !== undefined) patch.label = labelUpdate;
    await supabase.from("devices").update(patch).eq("id", body.device_id);
  }

  // --- UPSERT daily rollups (ADR-0083 §5) ---
  let dailyRollupsUpserted = 0;
  let sessionSummariesUpserted = 0;

  // Build both row sets up front so the response-shape diagnostic (#204) can
  // echo the exact `surface` / `provider` values the cloud actually persisted
  // — see `summarizeEnvelope` for why this matters.
  const rollupRows =
    body.payload.daily_rollups.length > 0
      ? buildRollupRows(
          body.device_id,
          body.synced_at,
          body.payload.daily_rollups
        )
      : [];
  const sessionRows =
    body.payload.session_summaries.length > 0
      ? buildSessionRows(
          body.device_id,
          body.synced_at,
          body.payload.session_summaries
        )
      : [];

  if (rollupRows.length > 0) {
    const { error: rollupError, count } = await supabase
      .from("daily_rollups")
      .upsert(rollupRows, {
        // Surface added to the PK in migration 014 so two surfaces on the
        // same (device, day, role, provider, model, repo, branch) combo
        // don't UPSERT-collide; the conflict target must mirror the new PK
        // shape exactly or PostgREST 400s with `no unique constraint`.
        onConflict:
          "device_id,bucket_day,role,provider,model,repo_id,git_branch,surface",
        count: "exact",
      });

    if (rollupError) {
      console.error("Failed to upsert daily_rollups:", rollupError);
      return Response.json(
        { error: "Failed to store daily rollups" },
        { status: 500 }
      );
    }
    dailyRollupsUpserted = count ?? rollupRows.length;
  }

  // --- UPSERT session summaries (ADR-0083 §5) ---
  // See `buildSessionRows` for the `started_at` coalescing that fixes #14.
  if (sessionRows.length > 0) {
    const { error: sessionError, count } = await supabase
      .from("session_summaries")
      .upsert(sessionRows, {
        onConflict: "device_id,session_id",
        count: "exact",
      });

    if (sessionError) {
      console.error("Failed to upsert session_summaries:", sessionError);
      return Response.json(
        { error: "Failed to store session summaries" },
        { status: 500 }
      );
    }
    sessionSummariesUpserted = count ?? sessionRows.length;
  }

  // --- Compute watermark: latest fully-synced bucket_day ---
  const { data: watermarkRow } = await supabase
    .from("daily_rollups")
    .select("bucket_day")
    .eq("device_id", body.device_id)
    .order("bucket_day", { ascending: false })
    .limit(1)
    .single();

  const watermark = watermarkRow?.bucket_day ?? null;

  // --- ADR-0083 §5: Success response ---
  // `records_upserted` stays for backward compatibility with existing daemon
  // builds; the per-table counts make session regressions obvious (#14).
  // `surfaces_seen` / `providers_seen` echo the exact axis values the cloud
  // persisted for this envelope — the diagnostic that closes the #204 audit
  // loop ("did the daemon actually send named surfaces?").
  const { surfaces_seen, providers_seen } = summarizeEnvelope(
    rollupRows,
    sessionRows
  );
  return Response.json({
    accepted: true,
    watermark,
    records_upserted: dailyRollupsUpserted + sessionSummariesUpserted,
    daily_rollups_upserted: dailyRollupsUpserted,
    session_summaries_upserted: sessionSummariesUpserted,
    surfaces_seen,
    providers_seen,
  });
}
