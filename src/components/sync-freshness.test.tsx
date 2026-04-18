import { describe, it, expect } from "vitest";
import { formatRelative } from "@/components/sync-freshness";

describe("formatRelative (sync freshness label)", () => {
  const now = Date.parse("2026-04-18T12:00:00Z");

  it.each([
    [now - 10_000, "just now"],
    [now - 30_000, "just now"],
    [now - 2 * 60 * 1000, "2m ago"],
    [now - 59 * 60 * 1000, "59m ago"],
    [now - 2 * 60 * 60 * 1000, "2h ago"],
    [now - 23 * 60 * 60 * 1000, "23h ago"],
    [now - 3 * 24 * 60 * 60 * 1000, "3d ago"],
    [now - 10 * 24 * 60 * 60 * 1000, "1w ago"],
    [now - 40 * 24 * 60 * 60 * 1000, "1mo ago"],
    [now - 400 * 24 * 60 * 60 * 1000, "1y ago"],
  ])("%d -> %s", (whenMs, expected) => {
    expect(formatRelative(whenMs, now)).toBe(expected);
  });

  it("never returns a negative-ago string if clocks drift forward", () => {
    // Daemon clock skew occasionally produces last_seen > now on cloud.
    // `formatRelative` should still render a sane label, not "−2m ago".
    expect(formatRelative(now + 30_000, now)).toBe("just now");
  });
});
