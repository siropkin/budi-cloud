import { type DateRange } from "@/lib/dal";
import { format, subDays } from "date-fns";
import { DEFAULT_PERIOD_DAYS } from "@/lib/periods";

/**
 * Build a `DateRange` from the `?days=` search param.
 *
 * Local Budi's developer-facing windows are `1d` / `7d` / `30d` (ADR-0088 §7).
 * To match the local semantics:
 *   - `days=1` means "today so far" — `from` and `to` are both today.
 *   - `days=7` means "the last 7 days including today" — from = today - 6.
 *   - `days=30` means "the last 30 days including today" — from = today - 29.
 *
 * Default (no param) is `7d` to mirror the default developer window in the
 * CLI and statusline. Invalid or non-positive values fall back to the default.
 */
export function dateRangeFromDays(days: string | undefined): DateRange {
  const parsed = days === undefined ? NaN : Number(days);
  const n =
    Number.isFinite(parsed) && parsed >= 1
      ? Math.floor(parsed)
      : DEFAULT_PERIOD_DAYS;
  const to = new Date();
  const from = subDays(to, n - 1);
  return {
    from: format(from, "yyyy-MM-dd"),
    to: format(to, "yyyy-MM-dd"),
  };
}
