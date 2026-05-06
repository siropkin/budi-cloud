import { type DateRange } from "@/lib/dal";
import { ALL_PERIOD_VALUE, DEFAULT_PERIOD_DAYS } from "@/lib/periods";
import {
  isValidTimeZone,
  localDateInTimeZone,
  utcBucketDayForLocalEnd,
  utcBucketDayForLocalStart,
  utcInstantForLocalEnd,
  utcInstantForLocalStart,
} from "@/lib/timezone";

/**
 * Build a `DateRange` from the `?days=` search param.
 *
 * Local Budi's developer-facing windows are `1d` / `7d` / `30d` (ADR-0088 §7)
 * and the CLI implements them as a *rolling* window starting N days back at
 * start-of-day-local and ending now. We mirror that here so cloud-vs-CLI
 * reconciliation for the same user, same period, lines up to the cent
 * (modulo the daemon's local sync queue):
 *   - `days=1` → from = yesterday, to = today (yesterday + today).
 *   - `days=7` → from = today - 7, to = today (8 day buckets).
 *   - `days=30` → from = today - 30, to = today (31 day buckets).
 *   - `days=all` is the cloud-only lifetime preset; `from` is materialized
 *     from the per-org earliest-activity lookup supplied by the caller.
 *
 * The captions ("Showing last N days") are copied verbatim from the local
 * CLI's labels — they describe the rolling-window concept, not the calendar
 * day count, which matches what users already read elsewhere in the budi
 * ecosystem (statusline, `budi stats -p Nd`, Claude Code integration).
 *
 * Default (no param) is `7d` to mirror the default developer window in the
 * CLI and statusline. Invalid or non-positive values fall back to the default.
 *
 * History:
 * - Prior to #75 the cloud treated `days=1` as "today so far" (single
 *   calendar day) and `days=N` as `N` days inclusive. That diverged from
 *   local Budi and produced confusing apples-to-apples reconciliation gaps.
 * - Prior to #78 "today" was always the **server's UTC date**. Vercel runs
 *   in UTC, so a US/Pacific user working at 17:30 PDT (= 00:30 UTC the next
 *   day) saw `days=1` filter `bucket_day BETWEEN today-UTC-1 AND today-UTC`
 *   — and silently dropped 5–7 hours of yesterday-PDT-evening activity that
 *   the daemon had written into "today's" UTC bucket. The fix below derives
 *   `from`/`to` in the viewer's IANA timezone and supplies a UTC bucket
 *   range that captures every UTC bucket overlapping the local-TZ window.
 */
export function dateRangeFromDays(
  days: string | undefined,
  earliestActivityDate?: string | null,
  timeZone?: string | null
): DateRange {
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
  const now = new Date();
  const localTo = localDateInTimeZone(now, tz);

  const from = computeLocalFrom(days, localTo, earliestActivityDate);
  return makeRange(from, localTo, tz);
}

/**
 * Same-length window immediately preceding `range`, for period-over-period
 * comparison on the Overview page (#150). Both bounds are derived in the same
 * `timeZone` as `range` so daylight-saving boundaries don't introduce a
 * one-hour drift between the two windows.
 *
 * Returns `null` when no meaningful comparison exists — the lifetime
 * (`?days=all`) preset already starts at the org's earliest activity, so
 * "the period before that" is by definition empty.
 */
export function previousDateRange(
  range: DateRange,
  timeZone?: string | null
): DateRange | null {
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
  const lengthDays = daysBetweenIso(range.from, range.to);
  if (lengthDays < 0) return null;
  const prevTo = subDaysIso(range.from, 1);
  const prevFrom = subDaysIso(prevTo, lengthDays);
  return makeRange(prevFrom, prevTo, tz);
}

function daysBetweenIso(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Resolve the lower bound of the local-TZ range from `days` and the optional
 * earliest-activity date. Kept separate so the rolling-window math reads
 * cleanly without the timezone plumbing on top.
 */
function computeLocalFrom(
  days: string | undefined,
  localTo: string,
  earliestActivityDate: string | null | undefined
): string {
  if (days === ALL_PERIOD_VALUE) {
    if (earliestActivityDate) return earliestActivityDate;
    return subDaysIso(localTo, DEFAULT_PERIOD_DAYS);
  }
  const parsed = days === undefined ? NaN : Number(days);
  const n =
    Number.isFinite(parsed) && parsed >= 1
      ? Math.floor(parsed)
      : DEFAULT_PERIOD_DAYS;
  return subDaysIso(localTo, n);
}

/**
 * Subtract `n` whole calendar days from a `YYYY-MM-DD` string. Implemented
 * against UTC to avoid pulling DST into a pure date-string operation —
 * `dateRangeFromDays` has already converted to local-TZ-aware values, so
 * arithmetic on the calendar-day strings themselves is timezone-neutral.
 */
function subDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function makeRange(from: string, to: string, tz: string): DateRange {
  return {
    from,
    to,
    bucketFrom: utcBucketDayForLocalStart(from, tz),
    bucketTo: utcBucketDayForLocalEnd(to, tz),
    startedAtFrom: utcInstantForLocalStart(from, tz),
    startedAtTo: utcInstantForLocalEnd(to, tz),
  };
}
