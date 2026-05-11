import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  clientIp,
  hashKey,
  rateLimit,
  rateLimitResponse,
} from "@/lib/rate-limit";

// #234: daemon polls this endpoint to mirror the team's negotiated pricing so
// the local recalc keeps matching cloud math. 60/min/key tracks the ingest cap
// — a healthy daemon polls every few minutes, retries on top.
const RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

// Server-side response freshness cap. Spec calls for a 5-min cache keyed by
// (org_id, list_version); we expose it via Cache-Control so any intermediary
// can honour it and so the daemon sees a stable hint even when our internal
// cache layer is bypassed.
const CACHE_MAX_AGE_SECONDS = 300;

type PricingRow = {
  platform: string;
  model_pattern: string;
  region: string | null;
  token_type: "input" | "output" | "cache_read" | "cache_write";
  sale_usd_per_mtok: number;
};

/**
 * Authenticate the request via Bearer token. Same shape as `/v1/ingest` and
 * `/v1/whoami`; intentionally duplicated so each endpoint stays grep-able.
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
    .select("id, org_id")
    .eq("api_key", apiKey)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Parse the optional `?since_version=N` short-circuit. Returns the integer or
 * `null` if the param is absent / malformed. Malformed values are treated as
 * "no since_version" rather than 400 — a daemon with corrupt state should
 * receive the full list and resynchronize, not bounce off a validation error.
 */
function parseSinceVersion(request: NextRequest): number | null {
  const raw = new URL(request.url).searchParams.get("since_version");
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * GET /v1/pricing/active
 *
 * Hands the daemon the org's active price list so local recalc stays in
 * lockstep with cloud math. Privacy-safe rows only — list (vendor-published)
 * price is procurement metadata and never leaves the cloud; the daemon needs
 * the sale price alone to compute `_effective`.
 *
 * Auth: Authorization: Bearer budi_<key>
 * Query: ?since_version=N (optional; daemon's last-seen version)
 *
 * Response (200): { org_id, list_version, effective_from, effective_to,
 *                   defaults: { platform, region }, rows: [...], generated_at }
 * Response (304): empty body — daemon is up to date
 * Response (404): { error: "No active price list" } — daemon treats as "no override"
 * Response (401): { error: "Unauthorized" } — daemon pauses pricing polling
 * Response (429): rate-limited
 *
 * Issue: siropkin/budi-cloud#234. Design: ADR-0094 §6.
 */
export async function GET(request: NextRequest) {
  // --- Pre-auth IP rate limit (#179 pattern) ---
  const ipLimit = await rateLimit(
    `pricing-active:ip:${clientIp(request)}`,
    RATE_LIMIT
  );
  if (!ipLimit.success) return rateLimitResponse(ipLimit.retryAfterSeconds);

  const supabase = createAdminClient();
  const authHeader = request.headers.get("authorization");
  const user = await authenticateApiKey(supabase, authHeader);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Per-key rate limit ---
  const keyLimit = await rateLimit(
    `pricing-active:key:${hashKey(authHeader!.slice(7))}`,
    RATE_LIMIT
  );
  if (!keyLimit.success) return rateLimitResponse(keyLimit.retryAfterSeconds);

  // --- Fetch active price lists currently in effect ---
  // Today must fall within [effective_from, effective_to or open). A list that
  // is `active` but dated in the future or already past is ignored — the
  // recalc engine would do the same, so the daemon should not mirror it.
  const today = new Date().toISOString().slice(0, 10);
  const { data: lists, error: listsError } = await supabase
    .from("org_price_lists")
    .select("id, effective_from, effective_to")
    .eq("org_id", user.org_id)
    .eq("status", "active")
    .lte("effective_from", today);

  if (listsError) {
    console.error("Failed to load org_price_lists:", listsError);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }

  const inWindow = (lists ?? []).filter(
    (l) =>
      l.effective_to === null ||
      l.effective_to === undefined ||
      (typeof l.effective_to === "string" && l.effective_to >= today)
  );

  if (inWindow.length === 0) {
    return Response.json({ error: "No active price list" }, { status: 404 });
  }

  // list_version is the MAX(id) of every active-in-window list — monotonic
  // when a manager activates a new list and stable across polls in between.
  // Same value goes into the ETag so clients have one identifier to track.
  const listVersion = inWindow.reduce(
    (max, l) => (typeof l.id === "number" && l.id > max ? l.id : max),
    0
  );
  const etag = `"${listVersion}"`;

  // --- 304 short-circuit on `since_version` or `If-None-Match` ---
  const since = parseSinceVersion(request);
  const ifNoneMatch = request.headers.get("if-none-match");
  const matchesEtag = ifNoneMatch !== null && ifNoneMatch.replace(/^W\//, "") === etag;
  if (since === listVersion || matchesEtag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": `private, max-age=${CACHE_MAX_AGE_SECONDS}`,
      },
    });
  }

  // --- Compute the union effective range across active lists ---
  // effective_from = MIN(effective_from); effective_to = MAX(effective_to)
  // with NULL acting as "still in effect" (so any NULL wins).
  let effectiveFrom: string = inWindow[0]!.effective_from as string;
  let effectiveTo: string | null = inWindow[0]!.effective_to as string | null;
  let openEnded = effectiveTo === null;
  for (const l of inWindow) {
    const from = l.effective_from as string;
    const to = l.effective_to as string | null;
    if (from < effectiveFrom) effectiveFrom = from;
    if (to === null) openEnded = true;
    else if (!openEnded && to > (effectiveTo ?? "")) effectiveTo = to;
  }
  if (openEnded) effectiveTo = null;

  // --- Fetch the rows for every active-in-window list ---
  const listIds = inWindow.map((l) => l.id as number);
  const { data: rowData, error: rowsError } = await supabase
    .from("org_price_list_rows")
    .select("platform, model_pattern, region, token_type, sale_usd_per_mtok")
    .in("list_id", listIds);

  if (rowsError) {
    console.error("Failed to load org_price_list_rows:", rowsError);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }

  const rows: PricingRow[] = (rowData ?? []).map((r) => ({
    platform: r.platform as string,
    model_pattern: r.model_pattern as string,
    region: (r.region as string | null) ?? null,
    token_type: r.token_type as PricingRow["token_type"],
    // sale_usd_per_mtok arrives as a NUMERIC string from postgrest — coerce to
    // a finite number so the daemon doesn't have to second-guess the type.
    sale_usd_per_mtok: Number(r.sale_usd_per_mtok),
  }));

  // --- Pricing defaults (platform / region) ---
  // Missing row → empty defaults object with null fields, matching the ADR
  // contract; the daemon's recalc treats nulls as "no preference".
  const { data: defaultsRow } = await supabase
    .from("org_pricing_defaults")
    .select("default_platform, default_region")
    .eq("org_id", user.org_id)
    .maybeSingle();

  const defaults = {
    platform: (defaultsRow?.default_platform as string | null) ?? null,
    region: (defaultsRow?.default_region as string | null) ?? null,
  };

  return Response.json(
    {
      org_id: user.org_id,
      list_version: listVersion,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      defaults,
      rows,
      generated_at: new Date().toISOString(),
    },
    {
      headers: {
        ETag: etag,
        "Cache-Control": `private, max-age=${CACHE_MAX_AGE_SECONDS}`,
      },
    }
  );
}
