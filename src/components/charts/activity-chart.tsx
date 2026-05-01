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
import { differenceInDays, format, startOfMonth, startOfWeek } from "date-fns";
import { fmtDate, fmtFullDate, fmtNum } from "@/lib/format";

interface ActivityData {
  bucket_day: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  message_count: number;
}

/**
 * For large spans the 1-row-per-day shape produces an unreadable sliver of
 * bars. Roll up to weekly buckets for > 60 days and monthly for > 1 year so
 * the lifetime (`?days=all`) view stays legible.
 */
function rebucket(data: ActivityData[]): ActivityData[] {
  if (data.length < 2) return data;
  const first = new Date(data[0].bucket_day + "T00:00:00");
  const last = new Date(data[data.length - 1].bucket_day + "T00:00:00");
  const span = differenceInDays(last, first);

  const keyFn =
    span > 365
      ? (d: Date) => format(startOfMonth(d), "yyyy-MM-dd")
      : span > 60
        ? (d: Date) => format(startOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd")
        : null;
  if (!keyFn) return data;

  const byBucket = new Map<string, ActivityData>();
  for (const row of data) {
    const key = keyFn(new Date(row.bucket_day + "T00:00:00"));
    const existing = byBucket.get(key);
    if (existing) {
      existing.input_tokens += row.input_tokens;
      existing.output_tokens += row.output_tokens;
      existing.cost_cents += row.cost_cents;
      existing.message_count += row.message_count;
    } else {
      byBucket.set(key, { ...row, bucket_day: key });
    }
  }
  return Array.from(byBucket.values()).sort((a, b) =>
    a.bucket_day.localeCompare(b.bucket_day)
  );
}

export function ActivityChart({ data }: { data: ActivityData[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        No activity data for this period
      </div>
    );
  }

  const bucketed = rebucket(data);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart
        data={bucketed}
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
          tickFormatter={fmtNum}
          tick={{ fill: "#71717a", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={72}
          label={{
            value: "Tokens",
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
          formatter={(value, name) => [
            fmtNum(Number(value)),
            String(name) === "input_tokens" ? "Input" : "Output",
          ]}
        />
        <Bar
          dataKey="input_tokens"
          stackId="tokens"
          fill="#3b82f6"
          maxBarSize={28}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="output_tokens"
          stackId="tokens"
          fill="#8b5cf6"
          maxBarSize={28}
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
