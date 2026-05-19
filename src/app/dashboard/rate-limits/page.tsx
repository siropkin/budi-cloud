import { Suspense } from "react";
import {
  getCurrentUser,
  getEarliestActivity,
  getKnownSurfaces,
  getWorkspaceMembers,
  getWindowTimeline,
  getThrottleEvents,
  getTeamRateLimitStats,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import { fmtCost, fmtNum, formatProvider } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PeriodSelector } from "@/components/filters/period-selector";
import { UnitsSelector } from "@/components/filters/units-selector";
import { UserFilter } from "@/components/filters/user-filter";
import { SurfaceFilter } from "@/components/filters/surface-filter";
import { parseSurfaceParam } from "@/lib/surface";
import { StatCard } from "@/components/stat-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { WindowUsageChart } from "./_components/window-usage-chart";
import { ThrottleEventsChart } from "./_components/throttle-events-chart";
import { BurnRateChart } from "./_components/burn-rate-chart";
import { TeamThrottleChart } from "./_components/team-throttle-chart";

export default async function RateLimitsPage({
  searchParams,
}: {
  searchParams: Promise<{
    days?: string;
    user?: string;
    units?: string;
    surface?: string;
  }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.workspace_id) return null;

  const unit = parseUnit(params.units);
  const surfaces = parseSurfaceParam(params.surface);
  const scope = { scopedUserId: params.user || null, surfaces };
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE
      ? await getEarliestActivity(user, scope)
      : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);

  const [windowTimeline, throttleEvents, teamStats, members, knownSurfaces] =
    await Promise.all([
      getWindowTimeline(user, range, scope),
      getThrottleEvents(user, range, scope),
      user.role === "manager"
        ? getTeamRateLimitStats(user, range, scope)
        : Promise.resolve([]),
      user.role === "manager"
        ? getWorkspaceMembers(user.workspace_id)
        : Promise.resolve([]),
      getKnownSurfaces(user, { scopedUserId: scope.scopedUserId }),
    ]);

  const isTokens = unit === "tokens";

  const totalWindows = windowTimeline.reduce((s, d) => s + d.window_count, 0);
  const totalThrottles = throttleEvents.length;
  const totalCostCents = windowTimeline.reduce((s, d) => s + d.cost_cents, 0);
  const totalTokens = windowTimeline.reduce(
    (s, d) => s + d.input_tokens + d.output_tokens,
    0
  );
  const avgBurnRate =
    windowTimeline.length > 0
      ? windowTimeline.reduce((s, d) => s + d.avg_burn_rate, 0) /
        windowTimeline.length
      : 0;

  const throttlePct =
    totalWindows > 0 ? ((totalThrottles / totalWindows) * 100).toFixed(1) : "0";

  const isManager = user.role === "manager";

  return (
    <div className="space-y-6">
      <PageHeader title="Rate Limits">
        <Suspense>
          <div className="flex flex-wrap items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <SurfaceFilter surfaces={knownSurfaces} />
            <UnitsSelector />
            <PeriodSelector />
          </div>
        </Suspense>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Windows" value={fmtNum(totalWindows)} />
        <StatCard
          title="Throttle events"
          value={fmtNum(totalThrottles)}
          subtitle={`${throttlePct}% of windows`}
        />
        <StatCard
          title={isTokens ? "Total tokens" : "Total cost"}
          value={isTokens ? fmtNum(totalTokens) : fmtCost(totalCostCents)}
        />
        <StatCard title="Avg burn rate" value={`${fmtCost(avgBurnRate)}/min`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {isTokens ? "Tokens" : "Cost"} per Window Period
          </CardTitle>
        </CardHeader>
        <CardContent>
          <WindowUsageChart data={windowTimeline} unit={unit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Throttle Events</CardTitle>
        </CardHeader>
        <CardContent>
          {throttleEvents.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
              No throttle events for this period
            </div>
          ) : (
            <div className="space-y-4">
              <ThrottleEventsChart
                data={
                  teamStats.length > 0
                    ? teamStats
                    : aggregateThrottlesByDay(throttleEvents)
                }
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-zinc-400">
                      <th className="pb-2 font-medium">Time</th>
                      <th className="pb-2 text-right font-medium">Duration</th>
                      <th className="pb-2 text-right font-medium">Messages</th>
                      <th className="pb-2 text-right font-medium">
                        {isTokens ? "Tokens" : "Cost"}
                      </th>
                      <th className="pb-2 text-right font-medium">Burn rate</th>
                      <th className="pb-2 font-medium">Provider</th>
                    </tr>
                  </thead>
                  <tbody>
                    {throttleEvents.slice(0, 50).map((e, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-2 text-zinc-200">
                          {new Date(e.started_at).toLocaleString()}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {Math.round(e.duration_minutes)}m
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {fmtNum(e.message_count)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {isTokens
                            ? fmtNum(e.input_tokens + e.output_tokens)
                            : fmtCost(e.cost_cents)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {fmtCost(e.burn_rate)}/min
                        </td>
                        <td className="py-2 text-zinc-300">
                          {formatProvider(e.provider)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Burn Rate Trend</CardTitle>
        </CardHeader>
        <CardContent>
          <BurnRateChart data={windowTimeline} />
        </CardContent>
      </Card>

      {isManager && (
        <Card>
          <CardHeader>
            <CardTitle>Team Rate Limit Impact</CardTitle>
          </CardHeader>
          <CardContent>
            <TeamThrottleChart data={teamStats} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function aggregateThrottlesByDay(events: { started_at: string }[]): {
  bucket_day: string;
  total_throttle_windows: number;
  users_hitting_limit: number;
}[] {
  const byDay = new Map<string, number>();
  for (const e of events) {
    const day = e.started_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return Array.from(byDay.entries())
    .map(([bucket_day, total_throttle_windows]) => ({
      bucket_day,
      total_throttle_windows,
      users_hitting_limit: 0,
    }))
    .sort((a, b) => a.bucket_day.localeCompare(b.bucket_day));
}
