import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildRollupRows,
  buildSessionRows,
  type IngestDailyRollup,
  type IngestSessionSummary,
} from "@/app/api/v1/ingest/rows";

// ADR-0083 §7: Max body size 1 MiB
const MAX_BODY_BYTES = 1024 * 1024;

const CURRENT_SCHEMA_VERSION = 1;

// Cap the stored label so a malformed envelope can't flood the devices table.
// 128 chars is comfortably above any sane hostname or user-chosen nickname.
const MAX_LABEL_LENGTH = 128;

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

  // --- Auth ---
  const supabase = createAdminClient();
  const user = await authenticateApiKey(
    supabase,
    request.headers.get("authorization")
  );
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  if (body.payload.daily_rollups.length > 0) {
    const rollupRows = buildRollupRows(
      body.device_id,
      body.synced_at,
      body.payload.daily_rollups
    );

    const { error: rollupError, count } = await supabase
      .from("daily_rollups")
      .upsert(rollupRows, {
        onConflict:
          "device_id,bucket_day,role,provider,model,repo_id,git_branch",
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
  if (body.payload.session_summaries.length > 0) {
    const sessionRows = buildSessionRows(
      body.device_id,
      body.synced_at,
      body.payload.session_summaries
    );

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
  return Response.json({
    accepted: true,
    watermark,
    records_upserted: dailyRollupsUpserted + sessionSummariesUpserted,
    daily_rollups_upserted: dailyRollupsUpserted,
    session_summaries_upserted: sessionSummariesUpserted,
  });
}
