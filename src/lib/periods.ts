/**
 * Shared time-window contract across the cloud dashboard.
 *
 * Aligned with the local-developer `1d` / `7d` / `30d` windows used by
 * `budi stats` and the Claude Code statusline, per ADR-0088 §7. Keeping the
 * periods, their order, and the default in one module means the dashboard,
 * tests, and any future server-side code all tell the same story.
 */
export const PERIODS = [
  { label: "1d", value: "1" },
  { label: "7d", value: "7" },
  { label: "30d", value: "30" },
] as const;

export type PeriodValue = (typeof PERIODS)[number]["value"];

/** Default landing window when no `?days=` is provided. */
export const DEFAULT_PERIOD_DAYS = 7;

/** Accepted numeric values for the core windows. */
export const ALLOWED_PERIOD_DAYS: ReadonlyArray<number> = PERIODS.map((p) =>
  Number(p.value)
);
