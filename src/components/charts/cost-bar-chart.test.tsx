import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { Bar, LabelList } from "recharts";
import { CostBarChart } from "./cost-bar-chart";
import { fmtCost } from "@/lib/format";

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
    expect(bar!.props.minPointSize).toBeGreaterThanOrEqual(4);
    expect(bar!.props.isAnimationActive).toBe(false);

    const labelList = nodes.find((n) => n.type === LabelList);
    expect(
      labelList,
      "LabelList should be inside Bar so each row gets a $X.XX suffix"
    ).toBeDefined();
    expect(labelList!.props.dataKey).toBe("cost_cents");
    expect(labelList!.props.position).toBe("right");

    // Formatter must round-trip a cents amount into the fmtCost form so the
    // regression where `$X.XX` goes missing can't sneak back in.
    const formatter = labelList!.props.formatter as (
      v: unknown
    ) => string | number;
    expect(formatter).toBeTypeOf("function");
    expect(formatter(3000)).toBe(fmtCost(3000));
    expect(formatter(81)).toBe(fmtCost(81));
  });
});
