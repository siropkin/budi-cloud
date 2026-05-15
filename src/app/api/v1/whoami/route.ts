import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  clientIp,
  hashKey,
  rateLimit,
  rateLimitResponse,
} from "@/lib/rate-limit";

// #179: whoami is the auto-bootstrap endpoint for `budi cloud init` — one
// hit per CLI invocation. 20/min/key is well above any legitimate usage and
// chokes off a brute-force scan against the api_key column.
const RATE_LIMIT = { limit: 20, windowSeconds: 60 } as const;

/**
 * Authenticate the request via Bearer token.
 * Returns the user row or null if auth fails. Mirrors the shape used by
 * `/v1/ingest/route.ts::authenticateApiKey`; intentionally duplicated so
 * each endpoint stays grep-able on its own.
 *
 * #274: when `workspace_id` is set we double-check that the workspace still
 * exists. `deleteWorkspace` cascades through the `users` table, so in the
 * normal path the api_key lookup above already fails. The workspace-
 * existence guard is defense-in-depth: a partial cascade, future schema
 * change, or stale row pointing at a vanished workspace must not keep
 * authenticating ingest.
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
    .select("id, workspace_id")
    .eq("api_key", apiKey)
    .single();

  if (error || !data) return null;

  if (data.workspace_id) {
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("id")
      .eq("id", data.workspace_id)
      .single();
    if (!workspace) return null;
  }

  return data;
}

/**
 * GET /v1/whoami
 *
 * Identifies the bearer of an API key so the CLI can auto-seed
 * `~/.config/budi/cloud.toml` with `workspace_id` without sending the user
 * to the dashboard to hand-copy it. Paired with siropkin/budi#541 on
 * the CLI side.
 *
 * Auth: Authorization: Bearer budi_<key>
 * Response (200): { "workspace_id": string, "org_id": string }
 * Response (401): { "error": "Unauthorized" }
 *
 * Dual-emit window (#321): `org_id` is the legacy field name kept for one
 * release cycle so daemons predating the rename keep parsing the response.
 * Both fields carry the same value; the legacy alias goes away after the
 * daemon's workspace-aware build has soaked.
 */
export async function GET(request: NextRequest) {
  // --- Pre-auth IP rate limit (#179) ---
  const ipLimit = await rateLimit(`whoami:ip:${clientIp(request)}`, RATE_LIMIT);
  if (!ipLimit.success) return rateLimitResponse(ipLimit.retryAfterSeconds);

  const supabase = createAdminClient();
  const authHeader = request.headers.get("authorization");
  const user = await authenticateApiKey(supabase, authHeader);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Per-key rate limit (#179) ---
  const keyLimit = await rateLimit(
    `whoami:key:${hashKey(authHeader!.slice(7))}`,
    RATE_LIMIT
  );
  if (!keyLimit.success) return rateLimitResponse(keyLimit.retryAfterSeconds);

  return Response.json({
    workspace_id: user.workspace_id,
    org_id: user.workspace_id,
  });
}
