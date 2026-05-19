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

interface WindowUsageDatum {
  bucket_day: string;
  window_count: number;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}

export function WindowUsageChart({
  data,
  unit,
}: {
  data: WindowUsageDatum[];
  unit: "dollars" | "tokens";
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        No window data for this period
      </div>
    );
  }

  const isTokens = unit === "tokens";
  const dataKey = isTokens ? "tokens" : "cost_cents";
  const label = isTokens ? "Tokens" : "Cost";

  const chartData = data.map((d) => ({
    ...d,
    tokens: d.input_tokens + d.output_tokens,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart
        data={chartData}
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
          allowDecimals={false}
          tickFormatter={(v) => (isTokens ? fmtNum(v) : fmtCost(v))}
          tick={{ fill: "#71717a", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={64}
          label={{
            value: label,
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
          labelFormatter={(l) => fmtFullDate(String(l))}
          formatter={(value, name) => {
            if (name === "cost_cents") return [fmtCost(Number(value)), "Cost"];
            return [fmtNum(Number(value)), "Tokens"];
          }}
        />
        <Bar
          dataKey={dataKey}
          fill="#3b82f6"
          maxBarSize={28}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
