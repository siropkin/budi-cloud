import { Suspense } from "react";
import {
  getCurrentUser,
  getOverviewStats,
  getDailyActivity,
  getEarliestActivity,
  getOrgMembers,
  getSyncFreshness,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { fmtCost, fmtNum } from "@/lib/format";
import { StatCard } from "@/components/stat-card";
import { PeriodSelector } from "@/components/period-selector";
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
  searchParams: Promise<{ days?: string; user?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const scopedUserId = params.user || null;
  const scope = { scopedUserId };
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE
      ? await getEarliestActivity(user, scope)
      : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  const [stats, activity, freshness, members] = await Promise.all([
    getOverviewStats(user, range, scope),
    getDailyActivity(user, range, scope),
    getSyncFreshness(user),
    user.role === "manager" ? getOrgMembers(user.org_id) : Promise.resolve([]),
  ]);

  // Decide which empty-state banner (if any) is most informative. The
  // freshness snapshot lets us tell "no devices yet" apart from "devices
  // exist but nothing synced yet" apart from "devices + data, just a quiet
  // window". Without this, all three used to collapse into "chart is empty".
  const showLinkBanner = freshness.deviceCount === 0;
  const showFirstSyncBanner =
    freshness.deviceCount > 0 && freshness.lastRollupAt === null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Overview</h1>
        <Suspense>
          <div className="flex items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

      {showLinkBanner && <LinkDaemonBanner apiKey={user.api_key} />}
      {showFirstSyncBanner && <FirstSyncInProgressBanner />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Cost" value={fmtCost(stats.totalCostCents)} />
        <StatCard
          title="Total Tokens"
          value={fmtNum(stats.totalInputTokens + stats.totalOutputTokens)}
          subtitle={`${fmtNum(stats.totalInputTokens)} in / ${fmtNum(stats.totalOutputTokens)} out`}
        />
        <StatCard title="Messages" value={fmtNum(stats.totalMessages)} />
        <StatCard title="Sessions" value={fmtNum(stats.totalSessions)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Daily Activity (Tokens)</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityChart data={activity} />
        </CardContent>
      </Card>
    </div>
  );
}
