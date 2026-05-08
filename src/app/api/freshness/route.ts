import { NextResponse } from "next/server";
import { getCurrentUser, getSyncFreshness } from "@/lib/dal";
import {
  enforceRateLimit,
  RATE_LIMITS,
  withRateLimitHeaders,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/freshness
 *
 * Returns the same shape as `getSyncFreshness` so the dashboard header badge
 * can poll for a newer `lastRollupAt` without re-rendering the entire layout.
 * The badge compares the polled `lastRollupAt` against the SSR'd
 * `renderedRollupAt` and triggers `router.refresh()` only when the daemon
 * has pushed something new (#133).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // #179: rate-limit per authenticated viewer. The dashboard polls this on
  // a header heartbeat, so 60/min is well above the legitimate cadence and
  // catches a compromised browser session being used as a side-channel.
  const { blocked, result: rl } = await enforceRateLimit({
    namespace: "freshness",
    identifier: user.id,
    ...RATE_LIMITS.freshness,
  });
  if (blocked) return blocked;

  const freshness = await getSyncFreshness(user);
  // No-store: this endpoint exists precisely to detect new uploads, so any
  // CDN/Next caching here would defeat the point.
  return withRateLimitHeaders(
    NextResponse.json(freshness, {
      headers: { "Cache-Control": "no-store" },
    }),
    rl
  );
}
