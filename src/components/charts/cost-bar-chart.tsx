"use client";

import {
  Bar,
  BarChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtCost } from "@/lib/format";

interface CostBarDatum {
  label: string;
  cost_cents: number;
}

const MAX_ITEMS = 10;
const BAR_SIZE = 28;
const BAR_GAP = 8;

function barChartHeight(rows: number): number {
  return Math.max(92, rows * (BAR_SIZE + BAR_GAP) + 32);
}

function truncateLabel(value: string, maxLen = 28): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1) + "\u2026";
}

export function CostBarChart({
  data,
  emptyLabel,
}: {
  data: CostBarDatum[];
  emptyLabel: string;
}) {
  const sorted = [...data]
    .sort((a, b) => b.cost_cents - a.cost_cents)
    .slice(0, MAX_ITEMS);

  if (sorted.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-zinc-500">
        {emptyLabel}
      </div>
    );
  }

  const height = barChartHeight(sorted.length);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={sorted}
        layout="vertical"
        barCategoryGap={BAR_GAP}
        margin={{ left: 20, right: 56, top: 6, bottom: 6 }}
      >
        <YAxis
          dataKey="label"
          type="category"
          tickLine={false}
          axisLine={false}
          width={180}
          interval={0}
          tick={({ x, y, payload }) => (
            <g transform={`translate(${x},${y})`}>
              <text
                x={0}
                y={0}
                dy={4}
                textAnchor="end"
                fill="#71717a"
                fontSize={12}
              >
                <title>{payload.value}</title>
                {truncateLabel(payload.value)}
              </text>
            </g>
          )}
        />
        <XAxis
          dataKey="cost_cents"
          type="number"
          tickFormatter={(v) => fmtCost(v)}
          axisLine={false}
          tickLine={false}
          tick={{ fill: "#71717a", fontSize: 12 }}
        />
        <Tooltip
          contentStyle={{
            background: "#18181b",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "8px",
            fontSize: "13px",
          }}
          formatter={(value) => [fmtCost(Number(value)), "Cost"]}
        />
        <Bar
          dataKey="cost_cents"
          fill="#3b82f6"
          barSize={BAR_SIZE}
          radius={[5, 5, 5, 5]}
          // Sub-dollar rows otherwise render at <1px next to a double-digit
          // leader. Floor the rendered width so every >0 row is still a
          // recognizable sliver; the cost label to the right is the
          // authoritative magnitude signal (#41).
          minPointSize={4}
          // recharts v3 gates LabelList on animation completion; if the Bar
          // ever fails to emit `onAnimationEnd` (e.g. under strict mode or
          // when re-rendered mid-animation) `<LabelList>` stays empty and the
          // `$X.XX` suffix is silently missing. Skip the animation so labels
          // render on first paint.
          isAnimationActive={false}
        >
          <LabelList
            dataKey="cost_cents"
            position="right"
            fill="#71717a"
            fontSize={12}
            formatter={(v) => fmtCost(Number(v))}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
