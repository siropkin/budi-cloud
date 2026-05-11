/**
 * "Effective vs list price" lens toggle for the Overview cost chart (#235).
 *
 * Each daily-rollup row carries two cost numbers since #231:
 *   - `cost_cents_effective` — what the recalculation engine landed on
 *     (defaults to ingested until #233 ships and a price list is active)
 *   - `cost_cents_ingested`  — what the daemon shipped, before any recalc
 *
 * The lens decides which column the chart series reads. Keep the values,
 * default, and parser in one module so every consumer agrees on the
 * `?lens=` wire shape and on what falls back when the param is absent or
 * malformed — the same recipe `units.ts` follows.
 */
export const COST_LENSES = [
  { label: "Effective", value: "effective" },
  { label: "List", value: "list" },
] as const;

export type CostLens = (typeof COST_LENSES)[number]["value"];

/** Default lens when the URL has no `?lens=` param. */
export const DEFAULT_COST_LENS: CostLens = "effective";

/** localStorage key used by `CostLensToggle` to persist the last choice. */
export const COST_LENS_STORAGE_KEY = "budi.dashboard.costLens";

/**
 * Coerce a raw `?lens=` value into a known lens. Anything other than the
 * literal `"list"` collapses to `"effective"` — the safer fallback, since
 * the effective column is what the rest of the dashboard reads.
 */
export function parseCostLens(raw: string | null | undefined): CostLens {
  return raw === "list" ? "list" : "effective";
}
