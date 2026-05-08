import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUser, getSyncFreshness } from "@/lib/dal";
import { clientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// #179: freshness is polled by the dashboard header badge. The current poll
// cadence is comfortably under 60/min; the cap exists to bound a compromised
// browser session abusing the endpoint as a side-channel.
const RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/**
 * GET /api/freshness
 *
 * Returns the same shape as `getSyncFreshness` so the dashboard header badge
 * can poll for a newer `lastRollupAt` without re-rendering the entire layout.
 * The badge compares the polled `lastRollupAt` against the SSR'd
 * `renderedRollupAt` and triggers `router.refresh()` only when the daemon
 * has pushed something new (#133).
 */
export async function GET(request: NextRequest) {
  // --- Pre-auth IP rate limit (#179) ---
  const ipLimit = await rateLimit(
    `freshness:ip:${clientIp(request)}`,
    RATE_LIMIT
  );
  if (!ipLimit.success) {
    return rateLimitResponse(ipLimit.retryAfterSeconds);
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Per-user rate limit (#179) ---
  // Once the Supabase session is resolved, switch to a per-user bucket so two
  // tabs from the same NAT don't share a single IP cap.
  const userLimit = await rateLimit(`freshness:user:${user.id}`, RATE_LIMIT);
  if (!userLimit.success) {
    return rateLimitResponse(userLimit.retryAfterSeconds);
  }

  const freshness = await getSyncFreshness(user);
  // No-store: this endpoint exists precisely to detect new uploads, so any
  // CDN/Next caching here would defeat the point.
  return NextResponse.json(freshness, {
    headers: { "Cache-Control": "no-store" },
  });
}
