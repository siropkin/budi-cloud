"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtCost, fmtDate, fmtFullDate } from "@/lib/format";

interface CostPerPersonDatum {
  bucket_day: string;
  cost_cents: number;
  active_members: number;
}

export function CostPerPersonChart({ data }: { data: CostPerPersonDatum[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        No team cost data for this period
      </div>
    );
  }

  // Days with no active members render as gaps rather than NaN/Infinity bars
  // so the chart visually matches the empty-state semantics elsewhere on the
  // page (#127 acceptance: "render a gap rather than dividing by zero").
  const series = data.map((d) => ({
    bucket_day: d.bucket_day,
    cost_per_person_cents:
      d.active_members > 0 ? d.cost_cents / d.active_members : null,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart
        data={series}
        margin={{ left: 16, right: 8, top: 8, bottom: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="rgba(255,255,255,0.06)"
          vertical={false}
        />
        <XAxis
          dataKey="bucket_day"
          tickFormatter={fmtDate}
          tick={{ fill: "#71717a", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={(v) => fmtCost(Number(v))}
          tick={{ fill: "#71717a", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={72}
          label={{
            value: "Cost / person",
            angle: -90,
            position: "insideLeft",
            offset: 0,
            dx: -8,
            style: { fill: "#71717a", fontSize: 12, textAnchor: "middle" },
          }}
        />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.05)" }}
          contentStyle={{
            background: "#18181b",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "8px",
            fontSize: "13px",
          }}
          labelFormatter={(label) => fmtFullDate(String(label))}
          formatter={(value) => [fmtCost(Number(value)), "Cost / person"]}
        />
        <Bar
          dataKey="cost_per_person_cents"
          fill="#f59e0b"
          maxBarSize={28}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
