import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { Bar, BarChart, LabelList } from "recharts";
import { fmtCost } from "@/lib/format";

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
      { label: "claude_code / claude-opus-4-7", cost_cents: 3000 },
      { label: "claude-opus-4-6", cost_cents: 81 },
      { label: "codex / (untagged)", cost_cents: 47 },
      { label: "tiny-1", cost_cents: 12 },
      { label: "tiny-2", cost_cents: 9 },
      { label: "tiny-3", cost_cents: 7 },
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
      "LabelList should be inside Bar so each row gets a $X.XX suffix"
    ).toBeDefined();
    const labelListProps = labelList!.props as {
      dataKey: string;
      position: string;
      formatter: (v: unknown) => string | number;
    };
    expect(labelListProps.dataKey).toBe("cost_cents");
    expect(labelListProps.position).toBe("right");

    // Formatter must round-trip a cents amount into the fmtCost form so the
    // regression where `$X.XX` goes missing can't sneak back in.
    const formatter = labelListProps.formatter;
    expect(formatter).toBeTypeOf("function");
    expect(formatter(3000)).toBe(fmtCost(3000));
    expect(formatter(81)).toBe(fmtCost(81));
  });

  it("strips the shared label prefix on compact widths so rows are visibly distinct (#121)", () => {
    isCompact = true;
    try {
      const collidingPrefix = [
        { label: "claude_code / claude-sonnet-4-5", cost_cents: 5000 },
        { label: "claude_code / claude-haiku-4-5", cost_cents: 3000 },
        { label: "claude_code / claude-opus-4-7", cost_cents: 1000 },
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
        { label: "alpha", cost_cents: 100 },
        { label: "beta", cost_cents: 50 },
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
