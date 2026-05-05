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
import { useMediaQuery } from "@/lib/use-media-query";

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

/**
 * Longest common prefix shared by all strings. Returns "" for fewer than two
 * inputs so we never strip from a single-row chart.
 */
function commonPrefix(values: string[]): string {
  if (values.length < 2) return "";
  let prefix = values[0];
  for (let i = 1; i < values.length && prefix.length > 0; i++) {
    const v = values[i];
    let j = 0;
    const max = Math.min(prefix.length, v.length);
    while (j < max && prefix.charCodeAt(j) === v.charCodeAt(j)) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

/**
 * Drop the longest common prefix from every label when truncation would
 * otherwise collapse rows onto each other \u2014 e.g. four rows of
 * `claude_code / claude-\u2026` lose the differentiating model id at mobile
 * widths. Only kicks in when the truncated forms actually collide and the
 * stripped forms are non-empty (#121).
 */
function stripSharedPrefix(labels: string[], maxLen: number): string[] {
  const truncated = labels.map((l) => truncateLabel(l, maxLen));
  if (new Set(truncated).size === truncated.length) return labels;
  const prefix = commonPrefix(labels);
  if (prefix.length === 0) return labels;
  const stripped = labels.map((l) => l.slice(prefix.length));
  if (stripped.some((l) => l.length === 0)) return labels;
  return stripped;
}

export function CostBarChart({
  data,
  emptyLabel,
}: {
  data: CostBarDatum[];
  emptyLabel: string;
}) {
  // At 390px the 180px label column plus 56px right padding claims ~60% of
  // the chart, leaving bars with no room. Shrink both below `sm` and leave
  // the desktop look untouched above it (#43).
  const isCompact = useMediaQuery("(max-width: 639px)");
  const yAxisWidth = isCompact ? 110 : 180;
  const rightMargin = isCompact ? 24 : 56;
  const leftMargin = isCompact ? 4 : 20;
  // On compact, 18 chars at fontSize 12 can exceed the 110px label column,
  // pushing right-anchored text into negative X so leading characters get
  // clipped (#120). 14 chars fits comfortably.
  const labelMaxLen = isCompact ? 14 : 28;

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

  // Strip the common prefix so e.g. `claude_code / claude-sonnet-4-5` and
  // `claude_code / claude-haiku-4-5` don't both truncate to
  // `claude_code / cla…` at mobile widths (#121). Keep the original on each
  // row for the SVG <title> so the full label is still discoverable.
  const displayLabels = stripSharedPrefix(
    sorted.map((d) => d.label),
    labelMaxLen
  );
  const rows = sorted.map((d, i) => ({
    ...d,
    displayLabel: displayLabels[i],
  }));

  const height = barChartHeight(sorted.length);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={rows}
        layout="vertical"
        barCategoryGap={BAR_GAP}
        margin={{ left: leftMargin, right: rightMargin, top: 6, bottom: 6 }}
      >
        <YAxis
          dataKey="displayLabel"
          type="category"
          tickLine={false}
          axisLine={false}
          width={yAxisWidth}
          interval={0}
          tick={({ x, y, payload, index }) => {
            const original = rows[index]?.label ?? payload.value;
            return (
              <g transform={`translate(${x},${y})`}>
                <text
                  x={0}
                  y={0}
                  dy={4}
                  textAnchor="end"
                  fill="#71717a"
                  fontSize={12}
                >
                  <title>{original}</title>
                  {truncateLabel(payload.value, labelMaxLen)}
                </text>
              </g>
            );
          }}
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
          cursor={{ fill: "rgba(255,255,255,0.05)" }}
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
