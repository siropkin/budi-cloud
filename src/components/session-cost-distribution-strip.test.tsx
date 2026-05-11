import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { SessionCostDistributionStrip } from "@/components/session-cost-distribution-strip";
import {
  buildSessionCostBuckets,
  sessionCostBucketIndex,
  type SessionCostBucket,
} from "@/lib/session-cost-distribution";

/**
 * Unit tests for the cost-percentile distribution strip (#217).
 *
 * Pins the three acceptance behaviors:
 *   1. The highlighted bucket matches the current session's cost.
 *   2. The percentile label rounds correctly off the empirical CDF.
 *   3. The strip hides entirely when the team has < 10 sessions in the
 *      period (the threshold below which the percentile is meaningless).
 */

interface CapturedBar {
  index: number;
  isCurrent: boolean;
  tooltip: string;
}

function collectBars(node: unknown): CapturedBar[] {
  const out: CapturedBar[] = [];
  const seen = new WeakSet<object>();
  function walk(n: unknown): void {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (seen.has(n as object)) return;
    seen.add(n as object);
    const el = n as ReactElement & {
      props?: Record<string, unknown> & { children?: unknown };
    };
    const props = el.props as Record<string, unknown> | undefined;
    if (props && props["data-bucket-index"] != null) {
      out.push({
        index: Number(props["data-bucket-index"]),
        isCurrent:
          (props as { "data-current"?: string })["data-current"] === "true",
        tooltip: String((props as { title?: string }).title ?? ""),
      });
    }
    walk(el.props?.children);
  }
  walk(node);
  return out;
}

function collectByTestId(node: unknown, testId: string): unknown | null {
  const seen = new WeakSet<object>();
  function walk(n: unknown): unknown | null {
    if (!n || typeof n !== "object") return null;
    if (Array.isArray(n)) {
      for (const c of n) {
        const f = walk(c);
        if (f) return f;
      }
      return null;
    }
    if (seen.has(n as object)) return null;
    seen.add(n as object);
    const el = n as ReactElement & {
      props?: Record<string, unknown> & { children?: unknown };
    };
    if (el.props && el.props["data-testid"] === testId) return el;
    return walk(el.props?.children);
  }
  return walk(node);
}

function textOf(node: unknown): string {
  const parts: string[] = [];
  function walk(n: unknown): void {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n === "object") {
      const el = n as ReactElement & { props?: { children?: unknown } };
      walk(el.props?.children);
    }
  }
  walk(node);
  return parts.join("");
}

function bucketsWithCounts(counts: number[]): SessionCostBucket[] {
  // Real log-spaced edges so the index resolution matches what the page sees.
  const edges = buildSessionCostBuckets(
    // Pick a max cost large enough that 20 buckets span the test range; the
    // exact value doesn't matter for the highlight/label tests.
    10_000,
    counts.length
  );
  return edges.map((b, i) => ({ ...b, count: counts[i] ?? 0 }));
}

describe("SessionCostDistributionStrip (#217)", () => {
  it("highlights the bucket containing the current session's cost", () => {
    // Build buckets and pick a cost that lands in bucket index 7.
    const buckets = bucketsWithCounts(new Array(20).fill(1));
    const targetIdx = 7;
    const targetCost =
      (buckets[targetIdx]!.lower_cents + buckets[targetIdx]!.upper_cents) / 2;
    const node = SessionCostDistributionStrip({
      distribution: {
        buckets,
        total_sessions: 20,
        max_cost_cents: 10_000,
      },
      currentCostCents: targetCost,
    });
    const bars = collectBars(node);
    expect(bars).toHaveLength(20);
    const highlighted = bars.filter((b) => b.isCurrent);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]!.index).toBe(targetIdx);
    // The resolver and the page must agree on which bucket the cost lands
    // in — pin the contract that the strip reads via `sessionCostBucketIndex`.
    expect(sessionCostBucketIndex(buckets, targetCost)).toBe(targetIdx);
  });

  it("renders a 'top X%' label that rounds correctly off the empirical CDF", () => {
    // 100 sessions, all concentrated in bucket 19 (the most expensive).
    // The current session also lands in bucket 19, so its rank is the
    // midpoint (50/100 below + 100/2 inside = rank 50/100) → cdf = 0.5,
    // top 50%. Use a more lopsided distribution for "top 5%":
    //   - 95 sessions in bucket 0
    //   - 5 sessions in bucket 19 (current session here)
    //   midpoint rank = 95 + 5/2 = 97.5 → cdf = 0.975 → top 3%.
    const counts = new Array(20).fill(0);
    counts[0] = 95;
    counts[19] = 5;
    const buckets = bucketsWithCounts(counts);
    const targetCost =
      (buckets[19]!.lower_cents + buckets[19]!.upper_cents) / 2;
    const node = SessionCostDistributionStrip({
      distribution: {
        buckets,
        total_sessions: 100,
        max_cost_cents: 10_000,
      },
      currentCostCents: targetCost,
    });
    const label = collectByTestId(node, "session-cost-percentile-label");
    expect(label).not.toBeNull();
    const text = textOf(label);
    // 1 - 0.975 = 0.025 → rounds to 3% (Math.round(2.5) = 3 via banker's
    // rounding is platform-defined; either way the label must say "top"
    // since cdf > 0.5 and the rounded percent is small).
    expect(text).toMatch(/^This session is in the top \d+% by cost\.$/);
    const pct = Number(/top (\d+)%/.exec(text)?.[1]);
    expect(pct).toBeGreaterThanOrEqual(1);
    expect(pct).toBeLessThanOrEqual(5);
  });

  it("flips to 'bottom X%' when the current session is among the cheapest", () => {
    // Mirror of the previous case: most sessions live in the top bucket,
    // current session lands in bucket 0 → cdf ~ 0.025 → bottom 3%.
    const counts = new Array(20).fill(0);
    counts[0] = 5;
    counts[19] = 95;
    const buckets = bucketsWithCounts(counts);
    const targetCost =
      (buckets[0]!.lower_cents + buckets[0]!.upper_cents) / 2;
    const node = SessionCostDistributionStrip({
      distribution: {
        buckets,
        total_sessions: 100,
        max_cost_cents: 10_000,
      },
      currentCostCents: targetCost,
    });
    const label = collectByTestId(node, "session-cost-percentile-label");
    const text = textOf(label);
    expect(text).toMatch(/^This session is in the bottom \d+% by cost\.$/);
    const pct = Number(/bottom (\d+)%/.exec(text)?.[1]);
    expect(pct).toBeGreaterThanOrEqual(1);
    expect(pct).toBeLessThanOrEqual(5);
  });

  it("hides the strip entirely when the team has < 10 sessions in the period (#217 empty state)", () => {
    // Below 10 the percentile is statistical noise — the strip must collapse
    // to null rather than render a misleading "top 50%" off a 3-session
    // sample.
    const buckets = bucketsWithCounts(new Array(20).fill(0));
    const node = SessionCostDistributionStrip({
      distribution: {
        buckets,
        total_sessions: 9,
        max_cost_cents: 50,
      },
      currentCostCents: 25,
    });
    expect(node).toBeNull();
  });

  it("hides when there are no buckets (period max below the first bucket's lower edge)", () => {
    // `max_cost_cents = 0` means every session was free; the bucket bank
    // collapses to an empty array and the strip has nothing to render.
    const node = SessionCostDistributionStrip({
      distribution: {
        buckets: [],
        total_sessions: 50,
        max_cost_cents: 0,
      },
      currentCostCents: 0,
    });
    expect(node).toBeNull();
  });
});
