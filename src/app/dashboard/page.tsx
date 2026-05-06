import { Suspense } from "react";
import {
  getCurrentUser,
  getOverviewStats,
  getDailyActivity,
  getEarliestActivity,
  getOrgMembers,
  getSyncFreshness,
} from "@/lib/dal";
import { dateRangeFromDays, previousDateRange } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import { fmtCost, fmtDelta, fmtNum } from "@/lib/format";
import { StatCard } from "@/components/stat-card";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { UserFilter } from "@/components/user-filter";
import { ActivityChart } from "@/components/charts/activity-chart";
import {
  LinkDaemonBanner,
  FirstSyncInProgressBanner,
} from "@/components/link-daemon-banner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; user?: string; units?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const unit = parseUnit(params.units);
  const scopedUserId = params.user || null;
  const scope = { scopedUserId };
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE
      ? await getEarliestActivity(user, scope)
      : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  // Same-length window immediately preceding `range` for period-over-period
  // deltas (#150). `null` for the lifetime preset where "the period before
  // earliest-activity" is empty by definition.
  const previousRange =
    params.days === ALL_PERIOD_VALUE ? null : previousDateRange(range, tz);
  const [stats, activity, freshness, members, previousStats, previousActivity] =
    await Promise.all([
      getOverviewStats(user, range, scope),
      getDailyActivity(user, range, scope),
      getSyncFreshness(user),
      user.role === "manager"
        ? getOrgMembers(user.org_id)
        : Promise.resolve([]),
      previousRange
        ? getOverviewStats(user, previousRange, scope)
        : Promise.resolve(null),
      previousRange
        ? getDailyActivity(user, previousRange, scope)
        : Promise.resolve([]),
    ]);

  // Caption for the headline-card delta (e.g. "vs previous 7d"). For numeric
  // ?days= we show the length verbatim; for any other window we say "previous
  // period" so the label stays accurate without inventing a number.
  const periodLengthDays = Number(params.days);
  const deltaCaption =
    Number.isFinite(periodLengthDays) && periodLengthDays >= 1
      ? `vs previous ${Math.floor(periodLengthDays)}d`
      : "vs previous period";

  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const previousTotalTokens = previousStats
    ? previousStats.totalInputTokens + previousStats.totalOutputTokens
    : 0;

  // Decide which empty-state banner (if any) is most informative. The
  // freshness snapshot lets us tell "no devices yet" apart from "devices
  // exist but nothing synced yet" apart from "devices + data, just a quiet
  // window". Without this, all three used to collapse into "chart is empty".
  const showLinkBanner = freshness.deviceCount === 0;
  const showFirstSyncBanner =
    freshness.deviceCount > 0 && freshness.lastRollupAt === null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Overview</h1>
        <Suspense>
          <div className="flex flex-wrap items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <UnitsSelector />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

      {showLinkBanner && <LinkDaemonBanner apiKey={user.api_key} />}
      {showFirstSyncBanner && <FirstSyncInProgressBanner />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {unit === "tokens" ? (
          <StatCard
            title="Total Tokens"
            value={fmtNum(totalTokens)}
            subtitle={`${fmtNum(stats.totalInputTokens)} in / ${fmtNum(stats.totalOutputTokens)} out`}
            delta={
              previousStats
                ? fmtDelta(totalTokens, previousTotalTokens)
                : undefined
            }
            deltaCaption={previousStats ? deltaCaption : undefined}
          />
        ) : (
          <StatCard
            title="Total Cost"
            value={fmtCost(stats.totalCostCents)}
            delta={
              previousStats
                ? fmtDelta(stats.totalCostCents, previousStats.totalCostCents)
                : undefined
            }
            deltaCaption={previousStats ? deltaCaption : undefined}
          />
        )}
        <StatCard
          title="Messages"
          value={fmtNum(stats.totalMessages)}
          delta={
            previousStats
              ? fmtDelta(stats.totalMessages, previousStats.totalMessages)
              : undefined
          }
          deltaCaption={previousStats ? deltaCaption : undefined}
        />
        <StatCard
          title="Sessions"
          value={fmtNum(stats.totalSessions)}
          delta={
            previousStats
              ? fmtDelta(stats.totalSessions, previousStats.totalSessions)
              : undefined
          }
          deltaCaption={previousStats ? deltaCaption : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{`Daily Activity (${unit === "tokens" ? "Tokens" : "Cost"})`}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityChart
            data={activity}
            previousData={previousActivity}
            unit={unit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
