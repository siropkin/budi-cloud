import { type DateRange } from "@/lib/dal";
import { format, subDays } from "date-fns";
import { ALL_PERIOD_VALUE, DEFAULT_PERIOD_DAYS } from "@/lib/periods";

/**
 * Build a `DateRange` from the `?days=` search param.
 *
 * Local Budi's developer-facing windows are `1d` / `7d` / `30d` (ADR-0088 §7).
 * To match the local semantics:
 *   - `days=1` means "today so far" — `from` and `to` are both today.
 *   - `days=7` means "the last 7 days including today" — from = today - 6.
 *   - `days=30` means "the last 30 days including today" — from = today - 29.
 *   - `days=all` is the cloud-only lifetime preset; `from` is materialized
 *     from the per-org earliest-activity lookup supplied by the caller.
 *
 * Default (no param) is `7d` to mirror the default developer window in the
 * CLI and statusline. Invalid or non-positive values fall back to the default.
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
      from: format(subDays(to, DEFAULT_PERIOD_DAYS - 1), "yyyy-MM-dd"),
      to: toStr,
    };
  }

  const parsed = days === undefined ? NaN : Number(days);
  const n =
    Number.isFinite(parsed) && parsed >= 1
      ? Math.floor(parsed)
      : DEFAULT_PERIOD_DAYS;
  return {
    from: format(subDays(to, n - 1), "yyyy-MM-dd"),
    to: toStr,
  };
}
