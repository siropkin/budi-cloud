import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtCost, repoName } from "@/lib/format";

/**
 * Same-day device timeline strip (#218). Renders every session that ran on
 * one device on one calendar day as a horizontal lane: X-axis is the
 * viewer's wall-clock day (00:00 → 23:59 in `timeZone`); each bar is
 * positioned by `started_at` and sized by `duration_ms`; cost is encoded as
 * color intensity so two adjacent low-cost sessions don't look the same as
 * one expensive one. The bar for the session currently on screen
 * (`currentSessionId`) is highlighted so a viewer instantly anchors "where
 * am I in this day's run."
 *
 * Empty-state contract (#218 acceptance): when this is the only session on
 * the device that day the strip collapses entirely — a one-bar timeline
 * carries no information beyond the cards above. The caller can also opt
 * out (`sessions.length === 0`) to keep the page tidy when the DAL hasn't
 * been wired in for a given route.
 *
 * Privacy (ADR-0083 §1): bars expose only the same numeric / hashed
 * metadata the Sessions list already shows — session id, repo hash, branch
 * (the daemon never sends file paths), and cost. No prompt/response/file
 * content reaches this component.
 */
export interface DeviceDayTimelineSession {
  session_id: string;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  repo_id: string | null;
  git_branch: string | null;
  total_cost_cents: number | string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Floor every bar at this width fraction so a 30-second session next to a
// 4-hour session still has a clickable hit-target. Mirrors the
// `minPointSize` floor the cost bar chart uses for the same reason (#41).
const MIN_BAR_WIDTH_PCT = 0.6;

export function DeviceDayTimeline({
  sessions,
  currentSessionId,
  timeZone,
  localDate,
}: {
  sessions: DeviceDayTimelineSession[];
  currentSessionId: string;
  timeZone: string;
  localDate: string;
}) {
  // One-row timelines carry no information beyond the cards above. Render
  // nothing rather than a single isolated bar (#218 acceptance).
  if (sessions.length < 2) return null;

  const dayStartMs = localDayStartUtcMs(localDate, timeZone);
  const maxCostCents = Math.max(
    1,
    ...sessions.map((s) => Number(s.total_cost_cents) || 0)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Same-day timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="relative h-10 w-full overflow-hidden rounded-md bg-white/[0.03]"
          data-testid="device-day-timeline-lane"
          role="list"
          aria-label="Sessions on this device today"
        >
          {sessions.map((session) => {
            const startedAtMs = new Date(session.started_at).getTime();
            const durationMs = clampDurationMs(session, dayStartMs);
            const leftFraction = clampFraction(
              (startedAtMs - dayStartMs) / DAY_MS
            );
            const widthFraction = Math.max(
              MIN_BAR_WIDTH_PCT / 100,
              clampFraction(durationMs / DAY_MS, 1 - leftFraction)
            );
            const isCurrent = session.session_id === currentSessionId;
            const cost = Number(session.total_cost_cents) || 0;
            const intensity = costToIntensity(cost, maxCostCents);
            const branch = (session.git_branch ?? "").replace(
              /^refs\/heads\//,
              ""
            );
            const repo = repoName(session.repo_id);
            const tooltip = [
              `Session ${session.session_id}`,
              repo ? `Repo ${repo}` : null,
              branch ? `Branch ${branch}` : null,
              `Cost ${fmtCost(cost)}`,
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <Link
                key={session.session_id}
                href={`/dashboard/sessions/${session.session_id}?device=${session.device_id}`}
                title={tooltip}
                role="listitem"
                aria-current={isCurrent ? "page" : undefined}
                aria-label={tooltip}
                data-current={isCurrent ? "true" : undefined}
                className={
                  "absolute top-1 bottom-1 rounded-sm transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-400" +
                  (isCurrent
                    ? " ring-2 ring-amber-300 ring-offset-1 ring-offset-zinc-950"
                    : "")
                }
                style={{
                  left: `${leftFraction * 100}%`,
                  width: `${widthFraction * 100}%`,
                  backgroundColor: barColor(intensity, isCurrent),
                  // Highlight current; dim the rest slightly so the eye lands
                  // on the highlighted bar first.
                  opacity: isCurrent ? 1 : 0.85,
                }}
              />
            );
          })}
        </div>
        <div
          className="mt-1 flex justify-between text-[10px] text-zinc-500"
          aria-hidden="true"
        >
          <span>00:00</span>
          <span>06:00</span>
          <span>12:00</span>
          <span>18:00</span>
          <span>24:00</span>
        </div>
      </CardContent>
    </Card>
  );
}

function clampFraction(value: number, max = 1): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

/**
 * Defensive duration clamp. The daemon writes `duration_ms` directly, but a
 * session that started near midnight may have `ended_at` rolling into the
 * next day; we cap the visible bar at "end of this local day" so it doesn't
 * spill past the lane and visually collide with the right edge.
 */
function clampDurationMs(
  session: DeviceDayTimelineSession,
  dayStartUtcMs: number
): number {
  const startedAtMs = new Date(session.started_at).getTime();
  if (session.duration_ms && session.duration_ms > 0) {
    return Math.min(session.duration_ms, dayStartUtcMs + DAY_MS - startedAtMs);
  }
  if (session.ended_at) {
    const endedMs = new Date(session.ended_at).getTime();
    if (endedMs > startedAtMs) {
      return Math.min(
        endedMs - startedAtMs,
        dayStartUtcMs + DAY_MS - startedAtMs
      );
    }
  }
  // Open-ended (still running) or daemon-side garbage: render a small fixed
  // sliver rather than zero so the row still presents a hit target.
  return 60_000;
}

/**
 * Local-day start in UTC ms. We don't pull in the heavy
 * `utcInstantForLocalStart` helper here because the timeline is rendered on
 * the server and the helper expects a `'YYYY-MM-DD'` + IANA TZ — the
 * caller hands us the same pair, and we just convert to a wall-clock ms.
 *
 * The conversion mirrors `wallClockInZoneToUtc` in `src/lib/timezone.ts`
 * but without dragging the full module surface into a client-renderable
 * component file. The fallback to UTC is what callers see when the
 * timezone cookie is missing (#78) — the strip degrades to a UTC day
 * rather than throwing.
 */
function localDayStartUtcMs(localDate: string, timeZone: string): number {
  const pretendUtc = new Date(`${localDate}T00:00:00Z`).getTime();
  try {
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(pretendUtc));
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour");
    const observed = new Date(
      `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}Z`
    ).getTime();
    const offsetMs = observed - pretendUtc;
    return pretendUtc - offsetMs;
  } catch {
    return pretendUtc;
  }
}

function costToIntensity(cost: number, maxCost: number): number {
  if (cost <= 0 || maxCost <= 0) return 0.15;
  // sqrt softens the curve so a single outlier session doesn't crush every
  // other bar to the same near-zero intensity (#41 / cost-bar floor).
  return 0.15 + 0.85 * Math.sqrt(Math.min(1, cost / maxCost));
}

function barColor(intensity: number, isCurrent: boolean): string {
  // Amber for the current row so it never visually collides with the
  // blue ramp the rest of the lane uses. The blue ramp matches the cost
  // bar chart's `fill="#3b82f6"` so the two surfaces feel like one family.
  if (isCurrent) return "rgba(252, 211, 77, 0.95)";
  return `rgba(59, 130, 246, ${intensity.toFixed(3)})`;
}
