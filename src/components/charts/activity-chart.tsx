"use client";

import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { differenceInDays, format, startOfMonth, startOfWeek } from "date-fns";
import { fmtCost, fmtDate, fmtFullDate, fmtNum } from "@/lib/format";
import type { Unit } from "@/lib/units";

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

interface ChartRow extends ActivityData {
  /** Previous-period token total at the same offset, when overlay is on. */
  previous_tokens?: number;
  /** Previous-period cost at the same offset, when overlay is on. */
  previous_cost_cents?: number;
  /** Bucket day from the previous-period series, for the tooltip label. */
  previous_bucket_day?: string;
}

/**
 * Align previous-period rows to current-period rows by index. The two windows
 * are constructed to be the same length, so position N in `previous` maps to
 * position N in `current` — the overlay reads as "what we did last week, on
 * the same day-of-week". Length mismatches (e.g. brand-new orgs whose first
 * sync started mid-window) just truncate to whichever is shorter.
 */
function withPreviousOverlay(
  current: ActivityData[],
  previous: ActivityData[],
  unit: Unit
): ChartRow[] {
  return current.map((row, i) => {
    const prev = previous[i];
    if (!prev) return row;
    return {
      ...row,
      previous_tokens:
        unit === "tokens" ? prev.input_tokens + prev.output_tokens : undefined,
      previous_cost_cents: unit === "tokens" ? undefined : prev.cost_cents,
      previous_bucket_day: prev.bucket_day,
    };
  });
}

export function ActivityChart({
  data,
  previousData = [],
  unit = "tokens",
}: {
  data: ActivityData[];
  /**
   * Optional same-length series from the period immediately preceding `data`,
   * rendered as a ghosted line overlay when the viewer toggles it on (#150).
   * Off by default so the default page render stays uncluttered.
   */
  previousData?: ActivityData[];
  unit?: Unit;
}) {
  const [showPrevious, setShowPrevious] = useState(false);

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        No activity data for this period
      </div>
    );
  }

  const bucketed = rebucket(data);
  const bucketedPrevious = rebucket(previousData);
  const isTokens = unit === "tokens";
  const fmt = isTokens ? fmtNum : fmtCost;
  const yAxisLabel = isTokens ? "Tokens" : "Cost";
  const hasPrevious = bucketedPrevious.length > 0;
  const rows: ChartRow[] = hasPrevious
    ? withPreviousOverlay(bucketed, bucketedPrevious, unit)
    : bucketed;

  return (
    <div>
      {hasPrevious && (
        <div className="mb-2 flex justify-end">
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              className="h-3 w-3 cursor-pointer accent-zinc-500"
              checked={showPrevious}
              onChange={(e) => setShowPrevious(e.target.checked)}
            />
            Compare to previous period
          </label>
        </div>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart
          data={rows}
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
              value: yAxisLabel,
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
            formatter={(value, name) => {
              const key = String(name);
              if (key === "previous_tokens" || key === "previous_cost_cents") {
                return [fmt(Number(value)), "Previous period"];
              }
              const seriesLabel = isTokens
                ? key === "input_tokens"
                  ? "Input"
                  : "Output"
                : "Cost";
              return [fmt(Number(value)), seriesLabel];
            }}
          />
          {isTokens ? (
            <>
              <Bar
                dataKey="input_tokens"
                stackId="value"
                fill="#3b82f6"
                maxBarSize={28}
                radius={[0, 0, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="output_tokens"
                stackId="value"
                fill="#8b5cf6"
                maxBarSize={28}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
              {showPrevious && hasPrevious && (
                <Line
                  type="monotone"
                  dataKey="previous_tokens"
                  stroke="rgba(255,255,255,0.45)"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              )}
            </>
          ) : (
            <>
              <Bar
                dataKey="cost_cents"
                fill="#3b82f6"
                maxBarSize={28}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
              {showPrevious && hasPrevious && (
                <Line
                  type="monotone"
                  dataKey="previous_cost_cents"
                  stroke="rgba(255,255,255,0.45)"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              )}
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
