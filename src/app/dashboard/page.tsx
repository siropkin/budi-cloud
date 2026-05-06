import { Suspense } from "react";
import {
  getCurrentUser,
  getOverviewStats,
  getDailyActivity,
  getEarliestActivity,
  getOrgMembers,
  getSyncFreshness,
  getCostByModel,
  getCostByRepo,
  getCostByUser,
  getActivityHeatmap,
  UNASSIGNED_USER_ID,
} from "@/lib/dal";
import { dateRangeFromDays, previousDateRange } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit, type Unit } from "@/lib/units";
import {
  fmtCost,
  fmtDelta,
  fmtNum,
  formatModelName,
  repoName,
} from "@/lib/format";
import { StatCard } from "@/components/stat-card";
import { TopBreakdownCard } from "@/components/top-breakdown-card";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { UserFilter } from "@/components/user-filter";
import { ActivityChart } from "@/components/charts/activity-chart";
import { ActivityHeatmap } from "@/components/charts/activity-heatmap";
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
  // Top contributor only renders for managers viewing the unfiltered org. With
  // a `?user=` filter the rest of the page already narrows to one teammate, so
  // a "leader" card showing that same teammate at 100% would be noise.
  const showTopContributor = user.role === "manager" && !scopedUserId;
  const [
    stats,
    activity,
    freshness,
    members,
    previousStats,
    topModels,
    topRepos,
    topUsers,
    heatmap,
  ] = await Promise.all([
    getOverviewStats(user, range, scope),
    getDailyActivity(user, range, scope),
    getSyncFreshness(user),
    user.role === "manager" ? getOrgMembers(user.org_id) : Promise.resolve([]),
    previousRange
      ? getOverviewStats(user, previousRange, scope)
      : Promise.resolve(null),
    getCostByModel(user, range, scope),
    getCostByRepo(user, range, scope),
    showTopContributor ? getCostByUser(user, range) : Promise.resolve([]),
    getActivityHeatmap(user, range, tz, scope),
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
  const hasSynced = !showLinkBanner && !showFirstSyncBanner;

  // Top breakdowns: pick the leader for each category and compute its share of
  // the period total. Same denominator as the headline card so the share lines
  // up with what the rest of the row reports. Sparkline reuses the period's
  // daily activity series — every card shows the same trend curve, since the
  // value is "did the period spike or coast?" not "did this leader spike?".
  const sparkline = sparkValues(activity, unit);
  const deepLinkSuffix = buildSearchParams({
    days: params.days,
    user: params.user,
    units: params.units,
  });
  const totalCostCents = stats.totalCostCents;
  const topModelLeader = topModels[0] ?? null;
  const topRepoLeader = topRepos[0] ?? null;
  // `getCostByUser` keeps the synthetic `Unassigned` bucket at the end, but
  // for "top contributor" we want a real teammate as the leader, not a
  // catch-all. Filter the bucket out before picking the head row.
  const topUserLeader =
    topUsers.find((u) => u.id !== UNASSIGNED_USER_ID) ?? null;
  const sharePct = (n: number) =>
    totalCostCents > 0 ? (n / totalCostCents) * 100 : null;

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

      {hasSynced && (
        <div
          className={`grid gap-4 sm:grid-cols-2 ${showTopContributor ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}
        >
          <TopBreakdownCard
            title="Top model"
            name={topModelLeader ? formatModelName(topModelLeader.model) : null}
            sharePct={
              topModelLeader ? sharePct(topModelLeader.cost_cents) : null
            }
            sparkline={sparkline}
            href={`/dashboard/models${deepLinkSuffix}`}
          />
          {showTopContributor && (
            <TopBreakdownCard
              title="Top contributor"
              name={topUserLeader ? topUserLeader.name : null}
              sharePct={
                topUserLeader ? sharePct(topUserLeader.cost_cents) : null
              }
              sparkline={sparkline}
              href={`/dashboard/team${deepLinkSuffix}`}
            />
          )}
          <TopBreakdownCard
            title="Top repo"
            name={topRepoLeader ? repoName(topRepoLeader.repo_id) : null}
            sharePct={topRepoLeader ? sharePct(topRepoLeader.cost_cents) : null}
            sparkline={sparkline}
            href={`/dashboard/repos${deepLinkSuffix}`}
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{`Daily Activity (${unit === "tokens" ? "Tokens" : "Cost"})`}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityChart data={activity} unit={unit} />
        </CardContent>
      </Card>

      {hasSynced && (
        <Card>
          <CardHeader>
            <CardTitle>{`Activity by Day & Hour (${unit === "tokens" ? "Sessions" : "Cost"})`}</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityHeatmap data={heatmap} unit={unit} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function sparkValues(
  series: Array<{
    cost_cents: number;
    input_tokens: number;
    output_tokens: number;
  }>,
  unit: Unit
): number[] {
  return series.map((d) =>
    unit === "tokens" ? d.input_tokens + d.output_tokens : d.cost_cents
  );
}

/**
 * Forward the active filters when linking from a leader card to its deep page,
 * so a manager who's viewing `/dashboard?days=30&user=abc` lands on
 * `/dashboard/models?days=30&user=abc` rather than the page's default window.
 */
function buildSearchParams(params: {
  days?: string;
  user?: string;
  units?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.days) sp.set("days", params.days);
  if (params.user) sp.set("user", params.user);
  if (params.units) sp.set("units", params.units);
  const q = sp.toString();
  return q ? `?${q}` : "";
}
