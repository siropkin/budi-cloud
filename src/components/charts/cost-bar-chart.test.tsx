import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { Bar, BarChart, LabelList } from "recharts";
import { fmtCost, fmtNum } from "@/lib/format";

// CostBarChart now calls `useMediaQuery` to shrink the y-axis column on
// narrow viewports. The hook is stubbed by a controllable function so each
// test can switch between the desktop and compact code paths.
let isCompact = false;
vi.mock("@/lib/use-media-query", () => ({
  useMediaQuery: () => isCompact,
}));

// Lazy import so the mock is applied before the component module evaluates.
const { CostBarChart } = await import("./cost-bar-chart");

/**
 * Walk a React element tree (without rendering) and yield every element node.
 * CostBarChart has no hooks so calling it as a function is safe under vitest's
 * node environment.
 */
function* walk(node: unknown): Generator<ReactElement> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  const el = node as ReactElement & {
    props?: { children?: unknown };
  };
  if (el.type != null) yield el;
  const children = el.props?.children;
  if (children !== undefined) yield* walk(children);
}

describe("CostBarChart", () => {
  it("renders the empty placeholder when no rows are supplied", () => {
    const tree = CostBarChart({ data: [], emptyLabel: "No data for period" });
    const text = JSON.stringify(tree);
    expect(text).toContain("No data for period");
  });

  it("configures Bar + LabelList so mixed-scale rows stay visible and labeled", () => {
    // Mirrors the repro from #41: one dominant row alongside sub-dollar rows.
    // Without minPointSize the non-leading bars shrink to <1px; without
    // isAnimationActive={false} LabelList silently stays empty on first paint.
    const mixedScale = [
      { label: "claude_code / claude-opus-4-7", cost_cents: 3000, tokens: 0 },
      { label: "claude-opus-4-6", cost_cents: 81, tokens: 0 },
      { label: "codex / (untagged)", cost_cents: 47, tokens: 0 },
      { label: "tiny-1", cost_cents: 12, tokens: 0 },
      { label: "tiny-2", cost_cents: 9, tokens: 0 },
      { label: "tiny-3", cost_cents: 7, tokens: 0 },
    ];
    const tree = CostBarChart({
      data: mixedScale,
      emptyLabel: "unused",
    });

    const nodes = Array.from(walk(tree));

    const bar = nodes.find((n) => n.type === Bar);
    expect(bar, "Bar should be in the rendered tree").toBeDefined();
    const barProps = bar!.props as {
      minPointSize: number;
      isAnimationActive: boolean;
    };
    expect(barProps.minPointSize).toBeGreaterThanOrEqual(4);
    expect(barProps.isAnimationActive).toBe(false);

    const labelList = nodes.find((n) => n.type === LabelList);
    expect(
      labelList,
      "LabelList should be inside Bar so each row gets a value suffix"
    ).toBeDefined();
    const labelListProps = labelList!.props as {
      dataKey: string;
      position: string;
      formatter: (v: unknown) => string | number;
    };
    // Both axes are now keyed off the unit-projected `value` field so the
    // toggle doesn't have to re-key the bar element on switch (#128).
    expect(labelListProps.dataKey).toBe("value");
    expect(labelListProps.position).toBe("right");

    // Default unit is dollars, so the formatter must round-trip cents into
    // the fmtCost form and the missing-suffix regression from #41 stays put.
    const formatter = labelListProps.formatter;
    expect(formatter).toBeTypeOf("function");
    expect(formatter(3000)).toBe(fmtCost(3000));
    expect(formatter(81)).toBe(fmtCost(81));
  });

  it("renders token totals when unit='tokens' (#128)", () => {
    const data = [
      { label: "alpha", cost_cents: 1000, tokens: 5_000_000 },
      { label: "beta", cost_cents: 200, tokens: 3_500_000 },
    ];
    const tree = CostBarChart({ data, emptyLabel: "unused", unit: "tokens" });
    const nodes = Array.from(walk(tree));

    const labelList = nodes.find((n) => n.type === LabelList);
    expect(labelList).toBeDefined();
    const formatter = (
      labelList!.props as { formatter: (v: unknown) => string | number }
    ).formatter;
    // Token mode formats with fmtNum (no $).
    expect(formatter(5_000_000)).toBe(fmtNum(5_000_000));
    expect(formatter(3_500_000)).toBe(fmtNum(3_500_000));

    // Sort order follows the projected token value, not cost — alpha leads
    // because 5M > 3.5M, even though both have positive cost.
    const barChart = nodes.find((n) => n.type === BarChart);
    const rows = (barChart!.props as { data: { value: number }[] }).data;
    expect(rows.map((r) => r.value)).toEqual([5_000_000, 3_500_000]);
  });

  it("strips the shared label prefix on compact widths so rows are visibly distinct (#121)", () => {
    isCompact = true;
    try {
      const collidingPrefix = [
        {
          label: "claude_code / claude-sonnet-4-5",
          cost_cents: 5000,
          tokens: 0,
        },
        {
          label: "claude_code / claude-haiku-4-5",
          cost_cents: 3000,
          tokens: 0,
        },
        { label: "claude_code / claude-opus-4-7", cost_cents: 1000, tokens: 0 },
      ];
      const tree = CostBarChart({
        data: collidingPrefix,
        emptyLabel: "unused",
      });
      const nodes = Array.from(walk(tree));
      const barChart = nodes.find((n) => n.type === BarChart);
      expect(barChart).toBeDefined();
      const data = (barChart!.props as { data: { displayLabel: string }[] })
        .data;
      // Common prefix `claude_code / claude-` is stripped so the model id is
      // what reaches the y-axis renderer (and stays distinct after truncation).
      expect(data.map((d) => d.displayLabel)).toEqual([
        "sonnet-4-5",
        "haiku-4-5",
        "opus-4-7",
      ]);
    } finally {
      isCompact = false;
    }
  });

  it("leaves labels alone when truncation alone keeps rows distinct", () => {
    isCompact = true;
    try {
      const distinctEnough = [
        { label: "alpha", cost_cents: 100, tokens: 0 },
        { label: "beta", cost_cents: 50, tokens: 0 },
      ];
      const tree = CostBarChart({
        data: distinctEnough,
        emptyLabel: "unused",
      });
      const nodes = Array.from(walk(tree));
      const barChart = nodes.find((n) => n.type === BarChart);
      const data = (barChart!.props as { data: { displayLabel: string }[] })
        .data;
      expect(data.map((d) => d.displayLabel)).toEqual(["alpha", "beta"]);
    } finally {
      isCompact = false;
    }
  });
});
