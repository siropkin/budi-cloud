"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const COOKIE_NAME = "budi_tz";
// One year — matches typical browser-detected-locale persistence. The cookie
// only carries the IANA TZ string; rotating it costs nothing if the user
// flies somewhere else, since the next render after the move overwrites it.
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Persists the viewer's IANA timezone (`Intl.DateTimeFormat...timeZone`)
 * into a cookie so server components can scope `?days=N` ranges to the
 * viewer's local "today" rather than server-UTC. See siropkin/budi-cloud#78
 * for the original gap (a US/Pacific user lost yesterday-evening activity
 * because the daemon's `bucket_day` is UTC and the cloud filtered against
 * server-UTC `now()`).
 *
 * Mounted once in the dashboard layout. The first paint of a fresh session
 * still uses the UTC fallback, but a subsequent navigation/refresh picks up
 * the cookie. We `router.refresh()` after writing so the freshly-loaded page
 * re-fetches its server data with the correct TZ instead of waiting for the
 * user's next click.
 */
export function TimeZoneSync({
  currentCookieTz,
}: {
  currentCookieTz: string | null;
}) {
  const router = useRouter();

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!detected || detected === currentCookieTz) return;

    document.cookie = [
      `${COOKIE_NAME}=${encodeURIComponent(detected)}`,
      "Path=/",
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      "SameSite=Lax",
    ].join("; ");

    // Re-render server components with the now-known TZ so the user doesn't
    // have to click a period button to see their data correctly scoped.
    router.refresh();
  }, [currentCookieTz, router]);

  return null;
}
