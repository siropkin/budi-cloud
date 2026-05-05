import { NextResponse } from "next/server";
import { getCurrentUser, getSyncFreshness } from "@/lib/dal";

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
  const freshness = await getSyncFreshness(user);
  // No-store: this endpoint exists precisely to detect new uploads, so any
  // CDN/Next caching here would defeat the point.
  return NextResponse.json(freshness, {
    headers: { "Cache-Control": "no-store" },
  });
}
