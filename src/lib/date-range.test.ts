import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dateRangeFromDays } from "@/lib/date-range";

describe("dateRangeFromDays (1d/7d/30d window contract)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to 7 days when no param is provided", () => {
    // 7d inclusive of today: from = today - 6.
    const r = dateRangeFromDays(undefined);
    expect(r.from).toBe("2026-04-12");
    expect(r.to).toBe("2026-04-18");
  });

  it("1d is a single-day window (today so far)", () => {
    const r = dateRangeFromDays("1");
    expect(r.from).toBe("2026-04-18");
    expect(r.to).toBe("2026-04-18");
  });

  it("7d includes today and the previous 6 days", () => {
    const r = dateRangeFromDays("7");
    expect(r.from).toBe("2026-04-12");
    expect(r.to).toBe("2026-04-18");
  });

  it("30d includes today and the previous 29 days", () => {
    const r = dateRangeFromDays("30");
    expect(r.from).toBe("2026-03-20");
    expect(r.to).toBe("2026-04-18");
  });

  it.each(["0", "-5", "abc", "", "NaN"])(
    "falls back to default for invalid value %s",
    (bad) => {
      const r = dateRangeFromDays(bad);
      expect(r.to).toBe("2026-04-18");
      expect(r.from).toBe("2026-04-12");
    }
  );

  it("accepts arbitrary positive custom windows via ?days=", () => {
    // Developers occasionally need a bespoke window; preserving this was one
    // of the compatibility notes on the 90d→30d default change.
    const r = dateRangeFromDays("14");
    expect(r.from).toBe("2026-04-05");
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
    expect(r.from).toBe("2026-04-12");
    expect(r.to).toBe("2026-04-18");
  });
});
