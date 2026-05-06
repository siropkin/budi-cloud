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
import { fmtDate, fmtFullDate, fmtNum } from "@/lib/format";

interface ModelCountDatum {
  bucket_day: string;
  active_models: number;
}

export function ModelCountChart({ data }: { data: ModelCountDatum[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        No model count data for this period
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ left: 16, right: 8, top: 8, bottom: 8 }}>
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
          tickFormatter={fmtNum}
          tick={{ fill: "#71717a", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={48}
          label={{
            value: "Active models",
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
          formatter={(value) => [fmtNum(Number(value)), "Active models"]}
        />
        <Bar
          dataKey="active_models"
          fill="#22c55e"
          maxBarSize={28}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
