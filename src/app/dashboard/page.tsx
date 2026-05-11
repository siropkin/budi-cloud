import { Suspense } from "react";
import {
  getCurrentUser,
  getOverviewStats,
  getDailyActivity,
  getEarliestActivity,
  getOrgHasActivePriceList,
  getOrgMembers,
  getSyncFreshness,
  getCostByModel,
  getCostByRepo,
  getCostByUser,
  getCostBySurface,
  getKnownSurfaces,
  getActivityHeatmap,
  UNASSIGNED_USER_ID,
} from "@/lib/dal";
import { dateRangeFromDays, previousDateRange } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit, type Unit } from "@/lib/units";
import { parseCostLens } from "@/lib/cost-lens";
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
import { SurfaceFilter } from "@/components/surface-filter";
import {
  formatSurface,
  isAllUnknownSurface,
  parseSurfaceParam,
} from "@/lib/surface";
import { ActivityChart } from "@/components/charts/activity-chart";
import { ActivityHeatmap } from "@/components/charts/activity-heatmap";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
import { CostLensToggle } from "@/components/cost-lens-toggle";
import {
  SavingsStrip,
  buildSavingsStripCopy,
} from "@/components/savings-strip";
import {
  LinkDaemonBanner,
  FirstSyncInProgressBanner,
} from "@/components/link-daemon-banner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    days?: string;
    user?: string;
    units?: string;
    surface?: string;
    lens?: string;
  }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const unit = parseUnit(params.units);
  const costLens = parseCostLens(params.lens);
  const scopedUserId = params.user || null;
  const surfaces = parseSurfaceParam(params.surface);
  const scope = { scopedUserId, surfaces };
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
  // Pick heatmap shape by period: hourly (DOW × hour) for short windows where
  // time-of-day is the interesting signal; GitHub-style calendar (DOW × week)
  // for 30d / lifetime where "which calendar days were active" is what the
  // viewer actually wants. Default `?days` is 7d, so missing → hourly.
  const heatmapMode: "hourly" | "calendar" = isHourlyHeatmapPeriod(params.days)
    ? "hourly"
    : "calendar";
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
    knownSurfaces,
    surfaceShare,
    hasActivePriceList,
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
    showTopContributor
      ? getCostByUser(user, range, scope)
      : Promise.resolve([]),
    heatmapMode === "hourly"
      ? getActivityHeatmap(user, range, tz, scope)
      : Promise.resolve([]),
    // The chip's option list is derived from data, not a hardcoded enum
    // (#187 part 1 — let JetBrains show up the day the first row arrives).
    // Intentionally not narrowed by the active `?surface=` so the chip can
    // still let the user widen out from a single-surface state.
    getKnownSurfaces(user, { scopedUserId }),
    getCostBySurface(user, range, scope),
    getOrgHasActivePriceList(user.org_id),
  ]);

  // Savings strip + Effective/List toggle (#235): only worth surfacing when
  // the org has an active price list *and* the period actually has a list
  // vs. effective gap. The two conditions are independent — a fresh upload
  // with no recalc yet still shows the toggle (per-row delta exists but
  // hasn't been materialized), so we don't collapse them into one flag.
  const ingestedTotal = stats.totalCostCentsIngested;
  const effectiveTotal = stats.totalCostCents;
  const periodHasSavings = hasActivePriceList && ingestedTotal > effectiveTotal;
  const hasAnyLensDelta = activity.some(
    (d) => d.cost_cents_ingested !== d.cost_cents
  );
  // Toggle is hidden when ingested == effective for every visible point —
  // acceptance criterion 2. Same gate covers the "no active price list"
  // case because without a list the recalc engine never diverges the two.
  const showCostLensToggle = hasActivePriceList && hasAnyLensDelta;

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
    surface: params.surface,
    // `lens` is intentionally not forwarded: it only configures the
    // Overview's cost chart, and the deep-link targets (Models, Team,
    // Repos) render their own breakdowns that always read `_effective`.
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
            <SurfaceFilter surfaces={knownSurfaces} />
            <UnitsSelector />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

      {showLinkBanner && <LinkDaemonBanner apiKey={user.api_key} />}
      {showFirstSyncBanner && <FirstSyncInProgressBanner />}

      {periodHasSavings && (
        <SavingsStrip
          {...buildSavingsStripCopy(ingestedTotal, effectiveTotal)}
        />
      )}

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
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{`Daily Activity (${unit === "tokens" ? "Tokens" : "Cost"})`}</CardTitle>
            {unit === "dollars" && showCostLensToggle && (
              <Suspense>
                <CostLensToggle />
              </Suspense>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ActivityChart data={activity} unit={unit} costLens={costLens} />
        </CardContent>
      </Card>

      {hasSynced && (
        <Card>
          <CardHeader>
            <CardTitle>{`Spend by Surface (${unit === "tokens" ? "Tokens" : "Cost"})`}</CardTitle>
          </CardHeader>
          <CardContent>
            <CostBarChart
              data={
                isAllUnknownSurface(surfaceShare)
                  ? []
                  : surfaceShare.map((s) => ({
                      label: formatSurface(s.surface),
                      cost_cents: s.cost_cents,
                      tokens: s.input_tokens + s.output_tokens,
                    }))
              }
              emptyLabel={
                isAllUnknownSurface(surfaceShare)
                  ? "Per-surface breakdown not available — every row in this window is tagged Unknown. Update local Budi to v8.4.2+ to start emitting surface tags."
                  : knownSurfaces.length <= 1
                    ? "Single-surface org — break out per-surface spend after a second IDE / CLI starts syncing."
                    : "No surface activity for this period"
              }
              unit={unit}
            />
          </CardContent>
        </Card>
      )}

      {hasSynced && (
        <Card>
          <CardHeader>
            <CardTitle>{heatmapTitle(heatmapMode, unit)}</CardTitle>
          </CardHeader>
          <CardContent>
            {heatmapMode === "hourly" ? (
              <ActivityHeatmap mode="hourly" data={heatmap} unit={unit} />
            ) : (
              <ActivityHeatmap
                mode="calendar"
                data={activity}
                range={{ from: range.from, to: range.to }}
                unit={unit}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function isHourlyHeatmapPeriod(days: string | undefined): boolean {
  // Default window is 7d (matches `dateRangeFromDays`), so an absent `days`
  // param is hourly. Anything beyond 7 days switches to the calendar view.
  if (days === undefined || days === "" || days === "1" || days === "7") {
    return true;
  }
  return false;
}

function heatmapTitle(mode: "hourly" | "calendar", unit: Unit): string {
  if (mode === "hourly") {
    return `Activity by Day & Hour (${unit === "tokens" ? "Sessions" : "Cost"})`;
  }
  return `Activity Calendar (${unit === "tokens" ? "Tokens" : "Cost"})`;
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
  surface?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.days) sp.set("days", params.days);
  if (params.user) sp.set("user", params.user);
  if (params.units) sp.set("units", params.units);
  if (params.surface) sp.set("surface", params.surface);
  const q = sp.toString();
  return q ? `?${q}` : "";
}
