import { clsx } from "clsx";
import type { VitalState } from "@/lib/dal";

/**
 * Vitals panel for `/dashboard/sessions/[id]` (#99). Mirrors the four
 * CLI-rendered scores from `budi sessions <id>` — Prompt Growth,
 * Cache Reuse, Retry Loops, Cost Acceleration — plus the rolled-up overall
 * state. The cloud only ever sees the score and the metric (no prompt /
 * response content); see ADR-0083 §1 and `006_session_vitals.sql`.
 *
 * When *all* vitals are null, the daemon either hasn't been upgraded or the
 * session was too short to score. The cloud can't reliably tell those two
 * cases apart from the row alone, so we show a single neutral notice rather
 * than misdirecting current daemons to a version upgrade.
 */

export interface SessionVitalsProps {
  contextDrag: { state: VitalState; metric: number | null };
  cacheEfficiency: { state: VitalState; metric: number | null };
  thrashing: { state: VitalState; metric: number | null };
  costAcceleration: { state: VitalState; metric: number | null };
  overall: VitalState;
}

interface VitalRowDef {
  label: string;
  /** Short hint shown under the label so a manager who isn't a budi power-user knows what they're looking at. */
  hint: string;
  state: VitalState;
  metric: number | null;
  /** Format the numeric metric for display ("18.2%/hr", "0.42 retries/turn", …). */
  format: (m: number) => string;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%/hr`;
}

function fmtRatio(n: number): string {
  return n.toFixed(2);
}

function fmtCurrency(n: number): string {
  return `$${(n / 100).toFixed(2)}/turn`;
}

export function SessionVitals(props: SessionVitalsProps) {
  const rows: VitalRowDef[] = [
    {
      label: "Prompt Growth",
      hint: "Context-window growth rate",
      state: props.contextDrag.state,
      metric: props.contextDrag.metric,
      format: fmtPct,
    },
    {
      label: "Cache Reuse",
      hint: "Cache-read efficiency",
      state: props.cacheEfficiency.state,
      metric: props.cacheEfficiency.metric,
      format: (m) => `${m.toFixed(0)}%`,
    },
    {
      label: "Retry Loops",
      hint: "Assistant retry / thrashing rate",
      state: props.thrashing.state,
      metric: props.thrashing.metric,
      format: fmtRatio,
    },
    {
      label: "Cost Acceleration",
      hint: "Cost per assistant turn",
      state: props.costAcceleration.state,
      metric: props.costAcceleration.metric,
      format: fmtCurrency,
    },
  ];

  const allEmpty = rows.every((r) => r.state == null) && props.overall == null;
  if (allEmpty) {
    return (
      <p className="text-sm text-zinc-400">
        Vitals unavailable for this session.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-zinc-400">Overall</span>
        <StateBadge state={props.overall} size="lg" />
      </div>
      <ul className="divide-y divide-white/5 border-y border-white/10">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center justify-between gap-4 py-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-200">
                {row.label}
              </div>
              <div className="text-xs text-zinc-500">{row.hint}</div>
            </div>
            <div className="flex items-center gap-3">
              <span className="tabular-nums text-sm text-zinc-300">
                {row.metric != null ? row.format(row.metric) : "—"}
              </span>
              <StateBadge state={row.state} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATE_STYLES: Record<NonNullable<VitalState>, string> = {
  green: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  yellow: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  red: "bg-red-500/15 text-red-300 border-red-500/30",
};

function StateBadge({
  state,
  size = "sm",
}: {
  state: VitalState;
  size?: "sm" | "lg";
}) {
  if (state == null) {
    return <span className="text-xs text-zinc-500">—</span>;
  }
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border font-medium uppercase tracking-wide",
        STATE_STYLES[state],
        size === "lg" ? "px-3 py-1 text-xs" : "px-2 py-0.5 text-[10px]"
      )}
    >
      {state}
    </span>
  );
}
