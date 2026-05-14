import { describe, it, expect } from "vitest";
import {
  COST_LENSES,
  COST_LENS_STORAGE_KEY,
  DEFAULT_COST_LENS,
  parseCostLens,
} from "./cost-lens";

/**
 * #282: lock in the `?lens=` parser contract. The Overview cost chart reads
 * this on every render, and a regression that flips the fallback from
 * `effective` → `list` (or vice-versa) would silently change which column
 * the chart draws for every viewer who lands without a query string.
 */

describe("parseCostLens", () => {
  it('returns "list" only for the exact literal', () => {
    expect(parseCostLens("list")).toBe("list");
  });

  it('returns "effective" for the matching literal', () => {
    expect(parseCostLens("effective")).toBe("effective");
  });

  it("falls back to the default for missing/empty input", () => {
    expect(parseCostLens(null)).toBe(DEFAULT_COST_LENS);
    expect(parseCostLens(undefined)).toBe(DEFAULT_COST_LENS);
    expect(parseCostLens("")).toBe(DEFAULT_COST_LENS);
  });

  it("falls back to the default for unknown values without throwing", () => {
    expect(parseCostLens("garbage")).toBe(DEFAULT_COST_LENS);
    expect(parseCostLens("LIST")).toBe(DEFAULT_COST_LENS);
    expect(parseCostLens(" list ")).toBe(DEFAULT_COST_LENS);
  });
});

describe("cost-lens constants", () => {
  it("exposes both lenses with the wire values the parser accepts", () => {
    expect(COST_LENSES.map((l) => l.value).sort()).toEqual([
      "effective",
      "list",
    ]);
  });

  it("uses a namespaced storage key so it never collides with another widget", () => {
    expect(COST_LENS_STORAGE_KEY).toMatch(/^budi\./);
  });

  it("defaults to the effective column the rest of the dashboard reads", () => {
    expect(DEFAULT_COST_LENS).toBe("effective");
  });
});
