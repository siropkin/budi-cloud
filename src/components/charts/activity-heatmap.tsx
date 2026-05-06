"use client";

import { clsx } from "clsx";
import { fmtCost, fmtNum } from "@/lib/format";
import type { Unit } from "@/lib/units";

interface HeatmapDatum {
  dow: number;
  hour: number;
  session_count: number;
  cost_cents: number;
}

// Mon-first ordering: developers think in work-week shape (Mon..Fri block,
// Sat/Sun trailing). Postgres returns DOW as 0=Sun..6=Sat, so we map row
// index → Postgres dow rather than reordering the data server-side.
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_ROW_TO_PG_DOW = [1, 2, 3, 4, 5, 6, 0];

// Match the Daily Activity chart's `ResponsiveContainer height={300}` so the
// two cards on the Overview line up vertically (#150).
const HEATMAP_HEIGHT = 300;

export function ActivityHeatmap({
  data,
  unit,
}: {
  data: HeatmapDatum[];
  unit: Unit;
}) {
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

  // Materialize a 7×24 grid keyed by `${dow}-${hour}`. Empty cells stay zero
  // — the SQL only emits non-empty buckets, so the client decides the shape.
  const cells = new Map<string, HeatmapDatum>();
  for (const d of data) cells.set(`${d.dow}-${d.hour}`, d);
  const valueOf = (d: HeatmapDatum | undefined): number =>
    d ? (unit === "tokens" ? d.session_count : d.cost_cents) : 0;
  // Color is opacity-on-blue scaled by cell value vs the period's max cell.
  // Without a per-period max the scale would compress every empty week into
  // a single dim cell as soon as one busy week showed up in history.
  const maxValue = Math.max(
    1,
    ...Array.from(cells.values()).map((d) => valueOf(d))
  );

  return (
    <div className="overflow-x-auto">
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
      </div>
    </div>
  );
}
