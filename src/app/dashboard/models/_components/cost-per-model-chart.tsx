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
import { fmtCost, fmtDate, fmtFullDate, fmtNum } from "@/lib/format";
import type { Unit } from "@/lib/units";

interface CostPerModelDatum {
  bucket_day: string;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
  active_models: number;
}

export function CostPerModelChart({
  data,
  unit = "dollars",
}: {
  data: CostPerModelDatum[];
  unit?: Unit;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        No model cost data for this period
      </div>
    );
  }

  const isTokens = unit === "tokens";
  const fmt = isTokens ? fmtNum : fmtCost;
  const seriesLabel = isTokens ? "Tokens / model" : "Cost / model";

  // Days with no active models render as gaps rather than NaN/Infinity bars
  // — same divide-by-zero guard as `CostPerDeviceChart` (#145).
  const series = data.map((d) => {
    if (d.active_models <= 0) {
      return { bucket_day: d.bucket_day, value: null as number | null };
    }
    const numerator = isTokens
      ? d.input_tokens + d.output_tokens
      : d.cost_cents;
    return { bucket_day: d.bucket_day, value: numerator / d.active_models };
  });

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
          tickFormatter={(v) => fmt(Number(v))}
          tick={{ fill: "#71717a", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={72}
          label={{
            value: seriesLabel,
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
          formatter={(value) => [fmt(Number(value)), seriesLabel]}
        />
        <Bar
          dataKey="value"
          fill="#f59e0b"
          maxBarSize={28}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
