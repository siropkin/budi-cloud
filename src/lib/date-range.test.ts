import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dateRangeFromDays, previousDateRange } from "@/lib/date-range";

/**
 * Pins the rolling-window contract introduced in #75. Each `days=N` query
 * spans `N + 1` day buckets (today minus N, through today inclusive) — the
 * same semantic the local Budi CLI uses for `-p Nd`. Older callers that
 * compared cloud and CLI numbers for the same window saw an off-by-one gap;
 * these tests pin the alignment so the regression can't return silently.
 *
 * The `from`/`to` fields here are scoped to the **viewer's local TZ** as of
 * #78. The default-UTC tests below mirror the pre-#78 behavior so the
 * server-UTC fallback (no cookie set yet on first paint) doesn't regress.
 * The PDT/AEST tests below are #78's actual contract.
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

  it("default UTC: bucket and started_at bounds collapse to the local-TZ range", () => {
    // For a UTC viewer, the daemon's `bucket_day` already matches the
    // viewer's local-TZ day so there is no UTC vs local drift to widen for.
    const r = dateRangeFromDays("1");
    expect(r.bucketFrom).toBe("2026-04-17");
    expect(r.bucketTo).toBe("2026-04-18");
    expect(r.startedAtFrom).toBe("2026-04-17T00:00:00.000Z");
    expect(r.startedAtTo).toBe("2026-04-18T23:59:59.999Z");
  });
});

describe("dateRangeFromDays (TZ-aware bucket bounds, #78)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("PDT user at 17:30 local (00:30 UTC next day): days=1 includes the UTC bucket their evening lands in", () => {
    // Reproduces the bug from #78: the user works at 17:30 PDT (= 00:30 UTC
    // the next day). The daemon writes `bucket_day` in UTC, so the user's
    // recent evening activity lives in "tomorrow's" UTC bucket. Without
    // TZ-awareness the cloud's `days=1` filter ran `BETWEEN today-UTC-1 AND
    // today-UTC` and silently dropped that evening of work.
    vi.setSystemTime(new Date("2026-04-28T00:30:00Z"));
    const r = dateRangeFromDays("1", null, "America/Los_Angeles");

    // User-facing range is PDT-local: yesterday-PDT + today-PDT.
    expect(r.from).toBe("2026-04-26");
    expect(r.to).toBe("2026-04-27");

    // bucket_day SQL filter must cover Apr 26 / Apr 27 / Apr 28 UTC — Apr 28
    // is the bucket that contains the user's PDT evening. Pre-#78 it stopped
    // at Apr 27 and that evening was excluded.
    expect(r.bucketFrom).toBe("2026-04-26");
    expect(r.bucketTo).toBe("2026-04-28");

    // started_at uses precise UTC instants — Apr 26 PDT 00:00 = Apr 26 07:00
    // UTC; Apr 27 PDT 23:59:59.999 = Apr 28 06:59:59.999 UTC.
    expect(r.startedAtFrom).toBe("2026-04-26T07:00:00.000Z");
    expect(r.startedAtTo).toBe("2026-04-28T06:59:59.999Z");
  });

  it("PDT user at 09:00 local (16:00 UTC same day): days=7 still rolls 7 calendar days back in PDT", () => {
    vi.setSystemTime(new Date("2026-04-27T16:00:00Z"));
    const r = dateRangeFromDays("7", null, "America/Los_Angeles");
    expect(r.from).toBe("2026-04-20");
    expect(r.to).toBe("2026-04-27");
  });

  it("AEST user east of UTC: bucket_day widens on the *earlier* edge instead", () => {
    // AEST is UTC+10. At 03:30 AEST (Apr 28) the UTC clock reads Apr 27
    // 17:30. days=1 → from=Apr 27 AEST, to=Apr 28 AEST. The user's earliest
    // wanted moment (Apr 27 AEST 00:00) is Apr 26 14:00 UTC, so we must
    // include the Apr 26 UTC bucket — symmetric mirror of the PDT case.
    vi.setSystemTime(new Date("2026-04-27T17:30:00Z"));
    const r = dateRangeFromDays("1", null, "Australia/Sydney");
    expect(r.from).toBe("2026-04-27");
    expect(r.to).toBe("2026-04-28");
    expect(r.bucketFrom).toBe("2026-04-26");
    expect(r.bucketTo).toBe("2026-04-28");
  });

  it("invalid TZ string falls back to UTC instead of throwing", () => {
    // Defends the cookie path — an attacker (or a stale browser) could send
    // any string. The fallback should be the pre-#78 server-UTC behavior.
    vi.setSystemTime(new Date("2026-04-18T12:00:00Z"));
    const r = dateRangeFromDays("1", null, "Not/A_Real_Zone");
    expect(r.from).toBe("2026-04-17");
    expect(r.to).toBe("2026-04-18");
  });

  it("'all' preserves earliest-activity lower bound in viewer's TZ", () => {
    vi.setSystemTime(new Date("2026-04-28T00:30:00Z"));
    const r = dateRangeFromDays("all", "2026-01-15", "America/Los_Angeles");
    expect(r.from).toBe("2026-01-15");
    expect(r.to).toBe("2026-04-27");
    // Bucket lower bound is the earliest UTC activity day — by construction
    // the daemon already wrote it in UTC, so the literal date is correct.
    expect(r.bucketFrom).toBe("2026-01-15");
    expect(r.bucketTo).toBe("2026-04-28");
  });
});

describe("previousDateRange (#150 — period-over-period on Overview)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("7d: returns the 8-day window immediately preceding the current 8-day window", () => {
    // Current 7d range is Apr 11 → Apr 18 (8 day buckets); the comparable
    // previous window is the 8 days ending the day before — Apr 3 → Apr 10.
    const current = dateRangeFromDays("7");
    const prev = previousDateRange(current);
    expect(prev?.from).toBe("2026-04-03");
    expect(prev?.to).toBe("2026-04-10");
  });

  it("1d: previous window is the two days before yesterday/today", () => {
    const current = dateRangeFromDays("1");
    const prev = previousDateRange(current);
    expect(prev?.from).toBe("2026-04-15");
    expect(prev?.to).toBe("2026-04-16");
  });

  it("preserves bucket and started_at bounds in the supplied timezone", () => {
    vi.setSystemTime(new Date("2026-04-28T00:30:00Z"));
    const current = dateRangeFromDays("1", null, "America/Los_Angeles");
    const prev = previousDateRange(current, "America/Los_Angeles");
    // Current is Apr 26–27 PDT; previous is Apr 24–25 PDT, with a UTC bucket
    // upper bound of Apr 26 (the bucket containing Apr 25 PDT evening) — same
    // shape as the current-window contract pinned above.
    expect(prev?.from).toBe("2026-04-24");
    expect(prev?.to).toBe("2026-04-25");
    expect(prev?.bucketFrom).toBe("2026-04-24");
    expect(prev?.bucketTo).toBe("2026-04-26");
  });
});
