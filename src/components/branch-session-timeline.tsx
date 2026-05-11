import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtCost, fmtNum } from "@/lib/format";
import { type BranchSessionTimelineRow } from "@/lib/dal";
import { type Unit } from "@/lib/units";

/**
 * "Same branch over time" bar chart on the session-detail page (#216).
 *
 * Renders one bar per session on the same `(repo_id, git_branch)` over the
 * trailing 30 days, sized by cost (or tokens, if the viewer's units toggle is
 * on tokens — same `?units=` contract the Sessions list uses, #84). The bar
 * for the session currently on screen is highlighted in amber so a viewer
 * instantly answers "has this branch been chewing tokens for weeks, or is
 * this a one-off spike?" — the manager-facing decision the detail page is
 * supposed to drive.
 *
 * Empty-state contract (#216 acceptance): when no *other* sessions exist on
 * this branch in the period — the current session is the only one — we
 * render a small explanatory line instead of a 0-bar chart. A single
 * one-bar chart carries no comparative information beyond what the cards
 * above already show.
 *
 * Privacy (ADR-0083 §1): only numeric metrics and the daemon-emitted
 * `session_id` reach this component. No prompt / response / file path
 * content is rendered.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_BAR_HEIGHT_PCT = 4;
// Five tick labels evenly span a 30-day window: one per week from the start
// of the range to today.
const TICK_COUNT = 5;

export function BranchSessionTimeline({
  sessions,
  currentSessionId,
  rangeStartIso,
  rangeEndIso,
  unit,
}: {
  sessions: BranchSessionTimelineRow[];
  currentSessionId: string;
  rangeStartIso: string;
  rangeEndIso: string;
  unit: Unit;
}) {
  // No sessions at all: the page didn't have a (repo, branch) to query on, or
  // visibility scope filtered every row out. Render nothing rather than an
  // empty card.
  if (sessions.length === 0) return null;

  const onlyCurrent =
    sessions.length === 1 && sessions[0]!.session_id === currentSessionId;

  const isTokens = unit === "tokens";
  const rangeStartMs = new Date(rangeStartIso).getTime();
  const rangeEndMs = new Date(rangeEndIso).getTime();
  // Defensive: a malformed range collapses to a single-day window so the
  // bars still render rather than throwing on a divide-by-zero.
  const spanMs = Math.max(DAY_MS, rangeEndMs - rangeStartMs);

  const values = sessions.map((s) =>
    isTokens
      ? Number(s.total_input_tokens) + Number(s.total_output_tokens)
      : Number(s.total_cost_cents)
  );
  const maxValue = Math.max(1, ...values);
  const weekTicks = buildWeekTicks(rangeStartMs, rangeEndMs);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Same branch over time</CardTitle>
      </CardHeader>
      <CardContent>
        {onlyCurrent ? (
          <p
            className="py-2 text-sm text-zinc-400"
            data-testid="branch-session-timeline-empty"
          >
            This is the only session on this branch in the last 30 days.
          </p>
        ) : (
          <>
            <div
              className="relative h-32 w-full overflow-hidden rounded-md bg-white/[0.03]"
              role="list"
              aria-label="Sessions on this branch over the last 30 days"
              data-testid="branch-session-timeline-bars"
            >
              {sessions.map((session, i) => {
                const startedMs = new Date(session.started_at).getTime();
                const leftFraction = clampFraction(
                  (startedMs - rangeStartMs) / spanMs
                );
                const value = values[i]!;
                const rawHeight = (value / maxValue) * 100;
                const heightPct = Math.max(
                  MIN_BAR_HEIGHT_PCT,
                  Number.isFinite(rawHeight) ? rawHeight : MIN_BAR_HEIGHT_PCT
                );
                const isCurrent = session.session_id === currentSessionId;
                const tooltip = buildTooltip(session, isTokens);
                return (
                  <Link
                    key={session.session_id}
                    href={`/dashboard/sessions/${encodeURIComponent(
                      session.session_id
                    )}`}
                    title={tooltip}
                    role="listitem"
                    aria-current={isCurrent ? "page" : undefined}
                    aria-label={tooltip}
                    data-current={isCurrent ? "true" : undefined}
                    data-session-id={session.session_id}
                    className={
                      "absolute bottom-0 rounded-sm transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-400 " +
                      (isCurrent
                        ? "bg-amber-300 w-[6px] -translate-x-[3px] opacity-100 z-10"
                        : "bg-blue-500/70 w-[3px] -translate-x-[1.5px] opacity-90")
                    }
                    style={{
                      left: `${leftFraction * 100}%`,
                      height: `${heightPct}%`,
                    }}
                  />
                );
              })}
            </div>
            <div
              className="mt-1 flex justify-between text-[10px] text-zinc-500"
              aria-hidden="true"
            >
              {weekTicks.map((t, i) => (
                <span key={i}>{t.label}</span>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function buildTooltip(
  session: BranchSessionTimelineRow,
  isTokens: boolean
): string {
  const startedAt = session.started_at
    ? new Date(session.started_at).toLocaleString()
    : "-";
  const value = isTokens
    ? `${fmtNum(
        Number(session.total_input_tokens) + Number(session.total_output_tokens)
      )} tokens`
    : fmtCost(Number(session.total_cost_cents));
  return `${startedAt} · ${value}`;
}

/**
 * Five tick labels evenly spaced across the visible range. The labels read
 * as `Mon DD` so a viewer can anchor any bar against a calendar date
 * without the row overflowing on narrow widths (the `flex justify-between`
 * parent spreads them edge-to-edge).
 */
function buildWeekTicks(
  rangeStartMs: number,
  rangeEndMs: number
): { label: string }[] {
  const span = Math.max(DAY_MS, rangeEndMs - rangeStartMs);
  const out: { label: string }[] = [];
  for (let i = 0; i < TICK_COUNT; i++) {
    const tickMs = rangeStartMs + (i * span) / (TICK_COUNT - 1);
    const d = new Date(tickMs);
    out.push({
      label: d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
    });
  }
  return out;
}
