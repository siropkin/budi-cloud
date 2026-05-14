import { describe, it, expect } from "vitest";
import { ALL_PERIOD_VALUE, DEFAULT_PERIOD_DAYS, PERIODS } from "./periods";

/**
 * #282: keep the shared `?days=` contract honest. The dashboard, the
 * statusline, and any future server-side selector all read this list, so
 * accidentally reordering it or dropping `All` would shuffle the chip row
 * for every viewer.
 */

describe("periods contract", () => {
  it("exposes 1d / 7d / 30d / All in that left-to-right order", () => {
    expect(PERIODS.map((p) => p.value)).toEqual(["1", "7", "30", "all"]);
    expect(PERIODS.map((p) => p.label)).toEqual(["1d", "7d", "30d", "All"]);
  });

  it("uses the documented sentinel for the lifetime window", () => {
    expect(ALL_PERIOD_VALUE).toBe("all");
    expect(PERIODS.at(-1)?.value).toBe(ALL_PERIOD_VALUE);
  });

  it("defaults to 7 days — matches the local `budi stats` landing window", () => {
    expect(DEFAULT_PERIOD_DAYS).toBe(7);
    expect(PERIODS.some((p) => p.value === String(DEFAULT_PERIOD_DAYS))).toBe(
      true
    );
  });
});
