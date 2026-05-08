import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  clientIp,
  hashKey,
  rateLimit,
  rateLimitResponse,
} from "@/lib/rate-limit";

// #179: status endpoint runs three Supabase queries per call and echoes
// `last_seen` / record counts, so cap polling well below the ingest rate.
const RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

/**
 * GET /v1/ingest/status
 *
 * Returns current watermark and sync health for the authenticated device.
 * Auth: Authorization: Bearer budi_<key>
 * Per ADR-0083 §7.
 */
export async function GET(request: NextRequest) {
  const supabase = createAdminClient();

  // --- Pre-auth IP rate limit (#179) ---
  const ipLimit = await rateLimit(
    `ingest_status:ip:${clientIp(request)}`,
    RATE_LIMIT
  );
  if (!ipLimit.success) return rateLimitResponse(ipLimit.retryAfterSeconds);

  // --- Auth ---
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = authHeader.slice(7);
  if (!apiKey.startsWith("budi_")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Per-key rate limit (#179) ---
  const keyLimit = await rateLimit(
    `ingest_status:key:${hashKey(apiKey)}`,
    RATE_LIMIT
  );
  if (!keyLimit.success) return rateLimitResponse(keyLimit.retryAfterSeconds);

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, org_id")
    .eq("api_key", apiKey)
    .single();

  if (userError || !user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Get device_id from query param ---
  const deviceId = request.nextUrl.searchParams.get("device_id");
  if (!deviceId) {
    return Response.json(
      { error: "Missing device_id query parameter" },
      { status: 400 }
    );
  }

  // --- Verify device belongs to user's org ---
  // Collapse "doesn't exist" and "belongs to another org" into the same 404
  // so a valid API key can't probe the global devices table for existence
  // across the org boundary (mirrors the getSessionDetail precedent in dal.ts).
  const notFound = () =>
    Response.json({ error: "Device not found" }, { status: 404 });

  const { data: device } = await supabase
    .from("devices")
    .select("id, user_id, last_seen")
    .eq("id", deviceId)
    .single();

  if (!device) {
    return notFound();
  }

  const { data: deviceOwner } = await supabase
    .from("users")
    .select("org_id")
    .eq("id", device.user_id)
    .single();

  if (!deviceOwner || deviceOwner.org_id !== user.org_id) {
    return notFound();
  }

  // --- Compute watermark: latest bucket_day for this device ---
  const { data: watermarkRow } = await supabase
    .from("daily_rollups")
    .select("bucket_day")
    .eq("device_id", deviceId)
    .order("bucket_day", { ascending: false })
    .limit(1)
    .single();

  // --- Count total records for this device ---
  const { count: rollupCount } = await supabase
    .from("daily_rollups")
    .select("*", { count: "exact", head: true })
    .eq("device_id", deviceId);

  const { count: sessionCount } = await supabase
    .from("session_summaries")
    .select("*", { count: "exact", head: true })
    .eq("device_id", deviceId);

  return Response.json({
    device_id: deviceId,
    watermark: watermarkRow?.bucket_day ?? null,
    last_seen: device.last_seen,
    total_rollup_records: rollupCount ?? 0,
    total_session_records: sessionCount ?? 0,
  });
}
