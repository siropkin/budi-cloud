import { type DateRange } from "@/lib/dal";
import { format, subDays } from "date-fns";
import { ALL_PERIOD_VALUE, DEFAULT_PERIOD_DAYS } from "@/lib/periods";

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
 * History: prior to #75 the cloud treated `days=1` as "today so far" (single
 * calendar day) and `days=N` as `N` days inclusive. That diverged from local
 * Budi and produced confusing apples-to-apples reconciliation gaps.
 */
export function dateRangeFromDays(
  days: string | undefined,
  earliestActivityDate?: string | null
): DateRange {
  const to = new Date();
  const toStr = format(to, "yyyy-MM-dd");

  if (days === ALL_PERIOD_VALUE) {
    // Without a known earliest activity date (empty org, or the caller
    // didn't fetch it) fall back to the default window rather than throwing.
    if (earliestActivityDate) {
      return { from: earliestActivityDate, to: toStr };
    }
    return {
      from: format(subDays(to, DEFAULT_PERIOD_DAYS), "yyyy-MM-dd"),
      to: toStr,
    };
  }

  const parsed = days === undefined ? NaN : Number(days);
  const n =
    Number.isFinite(parsed) && parsed >= 1
      ? Math.floor(parsed)
      : DEFAULT_PERIOD_DAYS;
  return {
    from: format(subDays(to, n), "yyyy-MM-dd"),
    to: toStr,
  };
}
