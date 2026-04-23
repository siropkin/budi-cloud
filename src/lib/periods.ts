/**
 * Shared time-window contract across the cloud dashboard.
 *
 * Aligned with the local-developer `1d` / `7d` / `30d` windows used by
 * `budi stats` and the Claude Code statusline, per ADR-0088 §7. Keeping the
 * periods, their order, and the default in one module means the dashboard,
 * tests, and any future server-side code all tell the same story.
 *
 * The cloud additionally exposes an `All` preset — a lifetime view backed by
 * the per-org earliest-activity lookup. Local Budi has no equivalent because
 * local stats are ephemeral; this is a cloud-only extension of the contract.
 */
export const PERIODS = [
  { label: "1d", value: "1" },
  { label: "7d", value: "7" },
  { label: "30d", value: "30" },
  { label: "All", value: "all" },
] as const;

/** Sentinel `?days=` value for the lifetime window. */
export const ALL_PERIOD_VALUE = "all";

/** Default landing window when no `?days=` is provided. */
export const DEFAULT_PERIOD_DAYS = 7;

/**
 * Human-readable caption for the active period — shown beside the selector so
 * a fresh user can tell at a glance which window the dashboard is summarizing.
 * Falls back to the default window when `days` is missing or unparseable so
 * the caption always matches what the data access layer actually queried.
 */
export function formatPeriodCaption(days: string | undefined): string {
  if (days === ALL_PERIOD_VALUE) return "Showing all time";
  const n = Number(days);
  const window = Number.isFinite(n) && n > 0 ? n : DEFAULT_PERIOD_DAYS;
  if (window === 1) return "Showing last 1 day";
  return `Showing last ${window} days`;
}
