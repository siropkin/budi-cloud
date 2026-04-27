import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dateRangeFromDays } from "@/lib/date-range";

/**
 * Pins the rolling-window contract introduced in #75. Each `days=N` query
 * spans `N + 1` day buckets (today minus N, through today inclusive) — the
 * same semantic the local Budi CLI uses for `-p Nd`. Older callers that
 * compared cloud and CLI numbers for the same window saw an off-by-one gap;
 * these tests pin the alignment so the regression can't return silently.
 */
describe("dateRangeFromDays (1d/7d/30d window contract)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to 7 days when no param is provided", () => {
    // 7d rolling: from = today - 7 (8 day buckets, including today).
    const r = dateRangeFromDays(undefined);
    expect(r.from).toBe("2026-04-11");
    expect(r.to).toBe("2026-04-18");
  });

  it("1d covers yesterday + today (matches local `budi stats -p 1d`)", () => {
    const r = dateRangeFromDays("1");
    expect(r.from).toBe("2026-04-17");
    expect(r.to).toBe("2026-04-18");
  });

  it("7d covers today and the previous 7 days", () => {
    const r = dateRangeFromDays("7");
    expect(r.from).toBe("2026-04-11");
    expect(r.to).toBe("2026-04-18");
  });

  it("30d covers today and the previous 30 days", () => {
    const r = dateRangeFromDays("30");
    expect(r.from).toBe("2026-03-19");
    expect(r.to).toBe("2026-04-18");
  });

  it.each(["0", "-5", "abc", "", "NaN"])(
    "falls back to default for invalid value %s",
    (bad) => {
      const r = dateRangeFromDays(bad);
      expect(r.to).toBe("2026-04-18");
      expect(r.from).toBe("2026-04-11");
    }
  );

  it("accepts arbitrary positive custom windows via ?days=", () => {
    // Developers occasionally need a bespoke window; preserving this was one
    // of the compatibility notes on the 90d→30d default change.
    const r = dateRangeFromDays("14");
    expect(r.from).toBe("2026-04-04");
    expect(r.to).toBe("2026-04-18");
  });

  it("'all' uses the provided earliest activity date as the lower bound", () => {
    const r = dateRangeFromDays("all", "2026-01-15");
    expect(r.from).toBe("2026-01-15");
    expect(r.to).toBe("2026-04-18");
  });

  it("'all' without an earliest activity date falls back to the default window", () => {
    // Defensive — the calling page is expected to provide it, but a brand-new
    // org with no rollups yet should still render like the default 7d view
    // rather than crashing.
    const r = dateRangeFromDays("all");
    expect(r.from).toBe("2026-04-11");
    expect(r.to).toBe("2026-04-18");
  });
});
