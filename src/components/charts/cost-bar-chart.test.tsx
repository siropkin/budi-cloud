import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { Bar, BarChart, LabelList, YAxis } from "recharts";
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
      content: (props: Record<string, unknown>) => ReactElement;
    };
    // Both axes are now keyed off the unit-projected `value` field so the
    // toggle doesn't have to re-key the bar element on switch (#128).
    expect(labelListProps.dataKey).toBe("value");

    // Default unit is dollars, so the content renderer must produce a <text>
    // node whose children is the fmtCost string. Exercises the
    // outside-the-bar branch (small value relative to the leader).
    const content = labelListProps.content;
    expect(content).toBeTypeOf("function");
    const outside = content({
      x: 100,
      y: 10,
      width: 30,
      height: 20,
      value: 81,
    });
    expect(outside.type).toBe("text");
    expect((outside.props as { children: string }).children).toBe(fmtCost(81));
    expect((outside.props as { textAnchor: string }).textAnchor).toBe("start");
  });

  it("always renders value labels outside the bar (#330)", () => {
    const saturating = [
      { label: "leader", cost_cents: 1000, tokens: 0 },
      { label: "tiny", cost_cents: 10, tokens: 0 },
    ];
    const tree = CostBarChart({ data: saturating, emptyLabel: "unused" });
    const nodes = Array.from(walk(tree));
    const labelList = nodes.find((n) => n.type === LabelList);
    const content = (
      labelList!.props as {
        content: (props: Record<string, unknown>) => ReactElement;
      }
    ).content;

    const leader = content({ x: 0, y: 0, width: 200, height: 20, value: 1000 });
    expect((leader.props as { textAnchor: string }).textAnchor).toBe("start");
    expect((leader.props as { fill: string }).fill).toBe("#71717a");

    const tiny = content({ x: 0, y: 0, width: 2, height: 20, value: 10 });
    expect((tiny.props as { textAnchor: string }).textAnchor).toBe("start");
    expect((tiny.props as { fill: string }).fill).toBe("#71717a");
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
    const content = (
      labelList!.props as {
        content: (props: Record<string, unknown>) => ReactElement;
      }
    ).content;
    // Token mode formats with fmtNum (no $).
    const tinyLabel = content({
      x: 0,
      y: 0,
      width: 10,
      height: 20,
      value: 3_500_000,
    });
    expect((tinyLabel.props as { children: string }).children).toBe(
      fmtNum(3_500_000)
    );

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

  it("omits the redundant <title> when the visible label already shows the full name (#205)", () => {
    // The y-axis tick used to always render <title>{original} alongside the
    // visible label. When original === visible, accessibility-tree / page-text
    // scrapes concatenated both and produced duplicates like "UnknownUnknown".
    const tree = CostBarChart({
      data: [{ label: "Unknown", cost_cents: 185983, tokens: 0 }],
      emptyLabel: "unused",
    });
    const nodes = Array.from(walk(tree));
    const yAxis = nodes.find((n) => n.type === YAxis);
    expect(yAxis).toBeDefined();
    const tick = (
      yAxis!.props as {
        tick: (args: {
          x: number;
          y: number;
          payload: { value: string };
          index: number;
        }) => ReactElement;
      }
    ).tick;
    const rendered = tick({
      x: 0,
      y: 0,
      payload: { value: "Unknown" },
      index: 0,
    });
    const tickNodes = Array.from(walk(rendered));
    // No <title> child means the label can't be doubled by the a11y tree.
    expect(tickNodes.find((n) => n.type === "title")).toBeUndefined();

    // Truncated rows still need <title> to expose the full original name.
    isCompact = true;
    try {
      const truncTree = CostBarChart({
        data: [
          {
            label: "really-long-surface-name-that-will-truncate",
            cost_cents: 100,
            tokens: 0,
          },
        ],
        emptyLabel: "unused",
      });
      const truncNodes = Array.from(walk(truncTree));
      const truncYAxis = truncNodes.find((n) => n.type === YAxis);
      const truncTick = (
        truncYAxis!.props as {
          tick: (args: {
            x: number;
            y: number;
            payload: { value: string };
            index: number;
          }) => ReactElement;
        }
      ).tick;
      const truncRendered = truncTick({
        x: 0,
        y: 0,
        payload: { value: "really-long-surface-name-that-will-truncate" },
        index: 0,
      });
      const truncTickNodes = Array.from(walk(truncRendered));
      const titleNode = truncTickNodes.find((n) => n.type === "title");
      expect(titleNode).toBeDefined();
      expect((titleNode!.props as { children: string }).children).toBe(
        "really-long-surface-name-that-will-truncate"
      );
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
