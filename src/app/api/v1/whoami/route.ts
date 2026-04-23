import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Authenticate the request via Bearer token.
 * Returns the user row or null if auth fails. Mirrors the shape used by
 * `/v1/ingest/route.ts::authenticateApiKey`; intentionally duplicated so
 * each endpoint stays grep-able on its own.
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
 * GET /v1/whoami
 *
 * Identifies the bearer of an API key so the CLI can auto-seed
 * `~/.config/budi/cloud.toml` with `org_id` without sending the user
 * to the dashboard to hand-copy it. Paired with siropkin/budi#541 on
 * the CLI side.
 *
 * Auth: Authorization: Bearer budi_<key>
 * Response (200): { "org_id": string }
 * Response (401): { "error": "Unauthorized" }
 *
 * No request body; all identity data derives from the key.
 */
export async function GET(request: NextRequest) {
  const supabase = createAdminClient();
  const user = await authenticateApiKey(
    supabase,
    request.headers.get("authorization")
  );
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json({ org_id: user.org_id });
}
