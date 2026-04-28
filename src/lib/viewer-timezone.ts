import "server-only";
import { cookies } from "next/headers";
import { isValidTimeZone } from "@/lib/timezone";

/**
 * Cookie name used by the dashboard to remember the viewer's IANA timezone.
 * The browser writes it on first dashboard render via `<TimeZoneSync />`;
 * the server reads it here when constructing date ranges. See #78 — the
 * cloud needs this to translate the daemon's UTC `bucket_day` into the
 * user's local "today" without dropping evening-local activity.
 */
export const TIMEZONE_COOKIE = "budi_tz";

/**
 * Resolve the viewer's IANA timezone from the cookie set by the browser, or
 * `null` if the cookie is missing/invalid. Callers fall back to UTC, which
 * preserves the pre-#78 behavior on the very first render of a fresh session
 * (before the client has had a chance to write the cookie).
 */
export async function getViewerTimeZone(): Promise<string | null> {
  const store = await cookies();
  const tz = store.get(TIMEZONE_COOKIE)?.value;
  if (!tz) return null;
  return isValidTimeZone(tz) ? tz : null;
}
