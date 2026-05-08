"use client";

import { useEffect, useRef } from "react";
import { clsx } from "clsx";
import { addDays, differenceInDays, format, startOfWeek } from "date-fns";
import { fmtCost, fmtNum } from "@/lib/format";
import type { Unit } from "@/lib/units";

interface HourlyDatum {
  dow: number;
  hour: number;
  session_count: number;
  cost_cents: number;
}

interface DailyDatum {
  bucket_day: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  message_count: number;
}

// Mon-first ordering: developers think in work-week shape (Mon..Fri block,
// Sat/Sun trailing). Postgres returns DOW as 0=Sun..6=Sat, so we map row
// index → Postgres dow rather than reordering the data server-side.
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_ROW_TO_PG_DOW = [1, 2, 3, 4, 5, 6, 0];
const WEEK_STARTS_ON = 1;

// Match the Daily Activity chart's `ResponsiveContainer height={300}` so the
// two cards on the Overview line up vertically (#150).
const HEATMAP_HEIGHT = 300;

// Calendar cells are fixed squares (GitHub-style) rather than flexing to fill
// the card, so 30d / All windows don't stretch into wide rectangles (#170).
// Sized to fit 7 rows + gaps + header + legend within HEATMAP_HEIGHT.
const CALENDAR_CELL_SIZE = "1.75rem";

type Props =
  | {
      mode: "hourly";
      data: HourlyDatum[];
      unit: Unit;
    }
  | {
      mode: "calendar";
      data: DailyDatum[];
      /** Inclusive ISO date strings (`YYYY-MM-DD`) defining the period. */
      range: { from: string; to: string };
      unit: Unit;
    };

export function ActivityHeatmap(props: Props) {
  return props.mode === "hourly" ? (
    <HourlyHeatmap {...props} />
  ) : (
    <CalendarHeatmap {...props} />
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Hourly view: 7 (DOW) × 24 (hour) — answers "what hours of the day are busy".
// ────────────────────────────────────────────────────────────────────────────

function HourlyHeatmap({ data, unit }: { data: HourlyDatum[]; unit: Unit }) {
  // Materialize a 7×24 grid keyed by `${dow}-${hour}`. Empty cells stay zero
  // — the SQL only emits non-empty buckets, so the client decides the shape.
  const cells = new Map<string, HourlyDatum>();
  for (const d of data) cells.set(`${d.dow}-${d.hour}`, d);
  const valueOf = (d: HourlyDatum | undefined): number =>
    d ? (unit === "tokens" ? d.session_count : d.cost_cents) : 0;

  // Default-scroll narrow viewports to the busiest hour so users on phones
  // don't see only midnight–noon by accident (#173). Computed across the full
  // 7×24 grid so a quiet evening doesn't pull focus away from a loud morning.
  const busiestHour = (() => {
    const totals = new Array<number>(24).fill(0);
    for (const d of data) totals[d.hour] += valueOf(d);
    let bestHour = 0;
    let bestTotal = -1;
    for (let h = 0; h < 24; h++) {
      if (totals[h] > bestTotal) {
        bestTotal = totals[h];
        bestHour = h;
      }
    }
    return bestTotal > 0 ? bestHour : null;
  })();

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (el.scrollWidth <= el.clientWidth) return;
    const target = busiestHour ?? new Date().getHours();
    // Center the chosen hour in the visible window. The grid has a 2.5rem day
    // label column followed by 24 equal-width hour cells, so position is
    // proportional to (target / 24) of the post-label width.
    const labelWidth = 40;
    const hourArea = el.scrollWidth - labelWidth;
    const center = labelWidth + (hourArea * (target + 0.5)) / 24;
    el.scrollLeft = Math.max(0, center - el.clientWidth / 2);
  }, [busiestHour]);

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-zinc-500"
        style={{ height: HEATMAP_HEIGHT }}
      >
        No session activity for this period
      </div>
    );
  }

  // Color is opacity-on-blue scaled by cell value vs the period's max cell.
  // Without a per-period max the scale would compress every empty week into
  // a single dim cell as soon as one busy week showed up in history.
  const maxValue = Math.max(
    1,
    ...Array.from(cells.values()).map((d) => valueOf(d))
  );

  return (
    <div className="relative">
      <div ref={scrollerRef} className="overflow-x-auto">
        <div
          className="flex flex-col"
          style={{ minWidth: 600, height: HEATMAP_HEIGHT }}
        >
        <div className="grid flex-none grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-x-1">
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className="text-center text-[10px] text-zinc-500"
              aria-hidden="true"
            >
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
        </div>
        <div className="mt-1 flex flex-1 flex-col gap-y-1">
          {DAY_ROW_TO_PG_DOW.map((dow, rowIdx) => (
            <div
              key={dow}
              className="grid flex-1 grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-x-1"
            >
              <div className="flex items-center text-xs text-zinc-500">
                {DAY_LABELS[rowIdx]}
              </div>
              {Array.from({ length: 24 }, (_, hour) => {
                const cell = cells.get(`${dow}-${hour}`);
                const value = valueOf(cell);
                const intensity =
                  value === 0 ? 0 : Math.max(0.08, value / maxValue);
                const sessions = cell?.session_count ?? 0;
                const cost = cell?.cost_cents ?? 0;
                const dayLabel = DAY_LABELS[rowIdx];
                const hourLabel = `${String(hour).padStart(2, "0")}:00`;
                const valueLabel =
                  unit === "tokens"
                    ? `${fmtNum(sessions)} session${sessions === 1 ? "" : "s"}`
                    : `${fmtCost(cost)} • ${fmtNum(sessions)} session${sessions === 1 ? "" : "s"}`;
                return (
                  <div
                    key={hour}
                    className={clsx(
                      "h-full rounded-sm",
                      value === 0 && "bg-white/[0.03]"
                    )}
                    style={
                      value > 0
                        ? {
                            backgroundColor: `rgba(59, 130, 246, ${intensity})`,
                          }
                        : undefined
                    }
                    title={`${dayLabel} ${hourLabel} — ${valueLabel}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <Legend />
        </div>
      </div>
      {/* Right-edge fade hints at horizontal scroll on narrow viewports
          (#173). Only shown below the grid's 600px minWidth — at wider
          viewports the chart fits and the fade would be misleading. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-0 w-8 bg-gradient-to-l from-[#0a0a0a] to-transparent md:hidden"
        style={{ height: HEATMAP_HEIGHT }}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Calendar view: 7 (DOW) × N (weeks) — GitHub-style contributions graph.
// Used for windows >7 days where time-of-day signal is too noisy and the
// user wants "which calendar days were active" instead.
// ────────────────────────────────────────────────────────────────────────────

function CalendarHeatmap({
  data,
  range,
  unit,
}: {
  data: DailyDatum[];
  range: { from: string; to: string };
  unit: Unit;
}) {
  const fromDate = parseISODate(range.from);
  const toDate = parseISODate(range.to);
  if (!fromDate || !toDate || differenceInDays(toDate, fromDate) < 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-zinc-500"
        style={{ height: HEATMAP_HEIGHT }}
      >
        No activity for this period
      </div>
    );
  }

  const byDay = new Map<string, DailyDatum>();
  for (const d of data) byDay.set(d.bucket_day, d);

  const valueOf = (d: DailyDatum | undefined): number => {
    if (!d) return 0;
    return unit === "tokens" ? d.input_tokens + d.output_tokens : d.cost_cents;
  };
  const maxValue = Math.max(1, ...data.map((d) => valueOf(d)));

  // Pad the visible range out to the nearest week boundary on each side so the
  // grid is always a clean 7-row block. Out-of-range days render blank.
  const gridStart = startOfWeek(fromDate, { weekStartsOn: WEEK_STARTS_ON });
  const totalDays = differenceInDays(toDate, gridStart) + 1;
  const weekCount = Math.max(1, Math.ceil(totalDays / 7));

  const weeks: Array<Array<{ date: Date; key: string; inRange: boolean }>> = [];
  for (let w = 0; w < weekCount; w++) {
    const col: Array<{ date: Date; key: string; inRange: boolean }> = [];
    for (let r = 0; r < 7; r++) {
      const date = addDays(gridStart, w * 7 + r);
      const key = format(date, "yyyy-MM-dd");
      const inRange = date >= fromDate && date <= toDate;
      col.push({ date, key, inRange });
    }
    weeks.push(col);
  }

  // Emit a month label when a week's first day kicks off a new month — keeps
  // the header sparse so labels don't crash into each other on narrow cards.
  const monthLabels: Array<string | null> = weeks.map((col, i) => {
    const firstDay = col[0].date;
    if (i === 0) return format(firstDay, "MMM");
    if (firstDay.getDate() <= 7) return format(firstDay, "MMM");
    return null;
  });

  const isTokens = unit === "tokens";
  const fmt = isTokens ? fmtNum : fmtCost;

  // Fixed-square cells with a static column width — 1fr would stretch each
  // day into a wide rectangle when the period spans only a few weeks (#170).
  // The day-label column stays auto so it shrinks to its text width.
  const gridTemplate = `auto repeat(${weekCount}, ${CALENDAR_CELL_SIZE})`;

  return (
    <div className="overflow-x-auto">
      <div
        className="flex flex-col justify-center"
        style={{ minHeight: HEATMAP_HEIGHT }}
      >
        <div
          className="grid flex-none gap-x-1"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          <div />
          {monthLabels.map((label, i) => (
            <div
              key={i}
              className="text-left text-[10px] text-zinc-500"
              aria-hidden="true"
            >
              {label ?? ""}
            </div>
          ))}
        </div>

        <div className="mt-1 flex flex-none flex-col gap-y-1">
          {DAY_ROW_TO_PG_DOW.map((_dow, rowIdx) => (
            <div
              key={rowIdx}
              className="grid flex-none gap-x-1"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <div className="flex items-center pr-2 text-xs text-zinc-500">
                {/* Show every other label (Mon/Wed/Fri/Sun) so rows don't
                    crowd when the cell height shrinks — same trick GitHub
                    uses on its contribution graph. */}
                {rowIdx % 2 === 0 ? DAY_LABELS[rowIdx] : ""}
              </div>
              {weeks.map((col, weekIdx) => {
                const cell = col[rowIdx];
                if (!cell.inRange) {
                  return (
                    <div
                      key={weekIdx}
                      className="rounded-sm"
                      style={{ height: CALENDAR_CELL_SIZE }}
                    />
                  );
                }
                const datum = byDay.get(cell.key);
                const value = valueOf(datum);
                const intensity =
                  value === 0 ? 0 : Math.max(0.08, value / maxValue);
                const dayLabel = format(cell.date, "EEE, MMM d");
                const valueLabel =
                  datum && value > 0 ? fmt(value) : "no activity";
                return (
                  <div
                    key={weekIdx}
                    className={clsx(
                      "rounded-sm",
                      value === 0 && "bg-white/[0.03]"
                    )}
                    style={{
                      height: CALENDAR_CELL_SIZE,
                      backgroundColor:
                        value > 0
                          ? `rgba(59, 130, 246, ${intensity})`
                          : undefined,
                    }}
                    title={`${dayLabel} — ${valueLabel}`}
                  />
                );
              })}
            </div>
          ))}
        </div>

        <Legend />
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-none items-center gap-2 text-[11px] text-zinc-500">
      <span>Less</span>
      {[0, 0.25, 0.5, 0.75, 1].map((step) => (
        <div
          key={step}
          className="h-3 w-3 rounded-sm"
          style={{
            backgroundColor:
              step === 0
                ? "rgba(255,255,255,0.06)"
                : `rgba(59, 130, 246, ${Math.max(0.08, step)})`,
          }}
        />
      ))}
      <span>More</span>
    </div>
  );
}

/** ISO `YYYY-MM-DD` → local Date. Returns `null` for invalid input. */
function parseISODate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}
