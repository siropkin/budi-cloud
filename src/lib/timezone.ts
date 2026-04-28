/**
 * Timezone helpers for translating between the dashboard viewer's local-TZ
 * "day" and the daemon's UTC-bucketed `daily_rollups.bucket_day`.
 *
 * Why this module exists: the daemon writes `bucket_day` in **UTC** while a
 * user thinks in their wall-clock day. For anyone west of UTC working in the
 * evening, the cloud's old `format(new Date(), "yyyy-MM-dd")` (server-UTC)
 * filter dropped 5–7 hours of *yesterday-local* activity into "tomorrow's UTC
 * bucket" and silently excluded it from `?days=1`. See siropkin/budi-cloud#78.
 *
 * The fix is to derive the bucket-side bounds from the local-TZ range:
 *
 *   - `localFrom 00:00:00` in the user's TZ → its UTC instant → its UTC date.
 *   - `localTo   23:59:59` in the user's TZ → its UTC instant → its UTC date.
 *
 * Including those bounding UTC dates (inclusive) covers every UTC bucket that
 * could possibly contain a message dated to the user's local-TZ window.
 *
 * The bound is loose by up to one UTC day on the *earlier* edge (the daytime
 * portion of the UTC bucket whose evening overlaps `localFrom`). That extra
 * day is acceptable: it's bounded, deterministic, and a small over-count is
 * preferred to silently dropping the user's most recent evening of work.
 *
 * The earlier-edge widening cleanly disappears once the daemon also writes
 * `bucket_day` in local time (option 3 in the issue), at which point this
 * helper still produces the correct bound.
 */

/**
 * Whether `tz` is a real IANA timezone identifier accepted by the JS runtime.
 * Used to defensively accept an attacker-supplied cookie without throwing.
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the local-TZ calendar date (`YYYY-MM-DD`) of `instant` in `timeZone`.
 * Uses Swedish locale because it formats dates as ISO 8601 natively, sparing
 * us a manual reorder of US-locale month/day/year parts.
 */
export function localDateInTimeZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * Return the UTC `Date` instant for the given wall-clock time interpreted in
 * `timeZone`. Handles DST correctly by deriving the offset *at that wall
 * clock*, not at "now".
 *
 * Strategy: pretend the wall clock IS UTC, ask the runtime what wall clock
 * that pretend-UTC instant produces in the target zone, and use the
 * difference as the offset. The actual UTC instant is the pretend-UTC minus
 * that offset.
 */
function wallClockInZoneToUtc(
  date: string,
  time: string,
  timeZone: string
): Date {
  const pretendUtc = new Date(`${date}T${time}Z`);
  // The TZ offset is identical regardless of the fractional-second component,
  // so we compute the offset against a second-aligned instant. This preserves
  // the original milliseconds end-to-end (e.g. `23:59:59.999` doesn't get
  // floored to `.998` by the seconds-only `Intl.DateTimeFormat`).
  const secAligned = new Date(Math.floor(pretendUtc.getTime() / 1000) * 1000);

  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(secAligned);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // `sv-SE` formats midnight as `00`, but `Intl` uses `24` for midnight in
  // some implementations; normalize.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const observedAsUtc = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}Z`
  );

  const offsetMs = observedAsUtc.getTime() - secAligned.getTime();
  return new Date(pretendUtc.getTime() - offsetMs);
}

/**
 * UTC date (`YYYY-MM-DD`) of `localDate 00:00:00` interpreted in `timeZone`.
 * For a US/Pacific user this is the calendar date the daemon wrote into
 * `bucket_day` for any message timestamped at the start of that local day.
 */
export function utcBucketDayForLocalStart(
  localDate: string,
  timeZone: string
): string {
  return wallClockInZoneToUtc(localDate, "00:00:00", timeZone)
    .toISOString()
    .slice(0, 10);
}

/**
 * UTC date (`YYYY-MM-DD`) of `localDate 23:59:59.999` interpreted in
 * `timeZone`. For users east of UTC the result is the same calendar day; for
 * users west of UTC it is typically the next UTC day, capturing the evening
 * activity the daemon writes into "tomorrow's" UTC bucket.
 */
export function utcBucketDayForLocalEnd(
  localDate: string,
  timeZone: string
): string {
  return wallClockInZoneToUtc(localDate, "23:59:59.999", timeZone)
    .toISOString()
    .slice(0, 10);
}

/**
 * UTC ISO instant of `localDate 00:00:00.000` in `timeZone`. Used as the
 * lower bound for `session_summaries.started_at`, which is a precise
 * timestamp (not a daily bucket) so we want the actual instant rather than
 * a calendar-day approximation.
 */
export function utcInstantForLocalStart(
  localDate: string,
  timeZone: string
): string {
  return wallClockInZoneToUtc(
    localDate,
    "00:00:00.000",
    timeZone
  ).toISOString();
}

/**
 * UTC ISO instant of `localDate 23:59:59.999` in `timeZone`. Inclusive upper
 * bound for `session_summaries.started_at`.
 */
export function utcInstantForLocalEnd(
  localDate: string,
  timeZone: string
): string {
  return wallClockInZoneToUtc(
    localDate,
    "23:59:59.999",
    timeZone
  ).toISOString();
}
