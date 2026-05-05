/**
 * Display-unit toggle shared across the dashboard (#128).
 *
 * The dashboard mixes two natural lenses on the same data:
 *   - dollars  — what finance/managers care about
 *   - tokens   — what engineers care about
 *
 * Both are derivable from the rollup rows (`cost_cents` and
 * `input_tokens + output_tokens`), so the toggle is purely a render-time
 * choice, not a query-shape change. Keeping the values, default, and parser
 * in one module means every page agrees on the wire format of `?units=`
 * and on what falls back when the param is missing or malformed.
 */
export const UNITS = [
  { label: "$", value: "dollars" },
  { label: "Tokens", value: "tokens" },
] as const;

export type Unit = (typeof UNITS)[number]["value"];

/** Default lens when the URL has no `?units=` param. */
export const DEFAULT_UNIT: Unit = "dollars";

/** localStorage key used by `UnitsSelector` to persist the last choice. */
export const UNITS_STORAGE_KEY = "budi.dashboard.units";

/**
 * Coerce a raw `?units=` value (or any string-ish) into a known unit. Falls
 * back to `DEFAULT_UNIT` for missing/unknown values so an unsupported value
 * pasted into a URL never crashes the page or silently shows mixed units.
 */
export function parseUnit(raw: string | null | undefined): Unit {
  return raw === "tokens" ? "tokens" : "dollars";
}
