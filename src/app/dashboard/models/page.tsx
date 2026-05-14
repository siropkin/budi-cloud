import { Suspense } from "react";
import {
  getCurrentUser,
  getCostByModel,
  getCostBySurface,
  getModelActivityByDay,
  getEarliestActivity,
  getOrgMembers,
  getKnownSurfaces,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import {
  buildCostCellTooltip,
  fmtCost,
  fmtNum,
  formatModelName,
  formatProvider,
} from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PeriodSelector } from "@/components/filters/period-selector";
import { UnitsSelector } from "@/components/filters/units-selector";
import { UserFilter } from "@/components/filters/user-filter";
import { SurfaceFilter } from "@/components/filters/surface-filter";
import {
  formatSurface,
  isAllUnknownSurface,
  parseSurfaceParam,
} from "@/lib/surface";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
import { ModelCountChart } from "@/app/dashboard/models/_components/model-count-chart";
import { CostPerModelChart } from "@/app/dashboard/models/_components/cost-per-model-chart";
import { StatCard } from "@/components/stat-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function ModelsPage({
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
  if (!user?.org_id) return null;

  const unit = parseUnit(params.units);
  const surfaces = parseSurfaceParam(params.surface);
  const scope = { scopedUserId: params.user || null, surfaces };
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE
      ? await getEarliestActivity(user, scope)
      : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  const [models, modelActivity, members, knownSurfaces, surfaceShare] =
    await Promise.all([
      getCostByModel(user, range, scope),
      getModelActivityByDay(user, range, scope),
      user.role === "manager"
        ? getOrgMembers(user.org_id)
        : Promise.resolve([]),
      getKnownSurfaces(user, { scopedUserId: scope.scopedUserId }),
      getCostBySurface(user, range, scope),
    ]);

  const isTokens = unit === "tokens";
  const valueWord = isTokens ? "Tokens" : "Cost";
  const perModelTitle = isTokens ? "Tokens per Model" : "Cost per Model";
  const fmtValue = (cost_cents: number, tokens: number) =>
    isTokens ? fmtNum(tokens) : fmtCost(cost_cents);

  // Chart label matches the table's `Model` column so reading across is
  // direct. Provider stays available as its own column in the table; the
  // bar chart de-duplicates by `(provider, model)` server-side, so two rows
  // with the same `formatModelName` from different providers will appear as
  // separate bars sharing a label — acceptable since the table next to it
  // disambiguates them.
  const chartRows = models.map((m) => ({
    label: formatModelName(m.model),
    cost_cents: m.cost_cents,
    tokens: m.input_tokens + m.output_tokens,
  }));

  // Headline stats for the time-series cards. `getCostByModel` already
  // filters out `(provider, model)` pairs with zero cost and zero tokens, so
  // every row here is "active" by the same definition the bar chart uses.
  // Mirrors the Devices-page filter applied in `activeDevices` (#145).
  const distinctActiveModels = models.length;
  const totalCostCents = models.reduce((s, m) => s + m.cost_cents, 0);
  const totalTokens = models.reduce(
    (s, m) => s + m.input_tokens + m.output_tokens,
    0
  );
  const perModelNumerator = isTokens ? totalTokens : totalCostCents;
  const avgPerModel =
    distinctActiveModels > 0 ? perModelNumerator / distinctActiveModels : null;

  const activeModelsLabel =
    distinctActiveModels > 0 ? fmtNum(distinctActiveModels) : "—";
  const avgPerModelLabel =
    avgPerModel === null
      ? "—"
      : isTokens
        ? fmtNum(Math.round(avgPerModel))
        : fmtCost(avgPerModel);

  return (
    <div className="space-y-6">
      <PageHeader title="Models">
        <Suspense>
          <div className="flex flex-wrap items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <SurfaceFilter surfaces={knownSurfaces} />
            <UnitsSelector />
            <PeriodSelector />
          </div>
        </Suspense>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>{`${valueWord} by Model`}</CardTitle>
        </CardHeader>
        <CardContent>
          {chartRows.length === 0 ? (
            <CostBarChart
              data={[]}
              emptyLabel={`No model ${valueWord.toLowerCase()} data for this period`}
              unit={unit}
            />
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <CostBarChart
                data={chartRows}
                emptyLabel={`No model ${valueWord.toLowerCase()} data for this period`}
                unit={unit}
              />
              <div>
                <table className="hidden w-full text-sm sm:table">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-zinc-400">
                      <th className="pb-2 font-medium">Provider</th>
                      <th className="pb-2 font-medium">Model</th>
                      <th className="pb-2 text-right font-medium">In</th>
                      <th className="pb-2 text-right font-medium">Out</th>
                      <th className="pb-2 text-right font-medium">
                        {valueWord}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m, i) => (
                      <tr
                        key={`${m.provider}/${m.model}/${i}`}
                        className="border-b border-white/5"
                      >
                        <td className="py-2 text-zinc-200">
                          {formatProvider(m.provider)}
                        </td>
                        <td className="py-2 text-zinc-200">
                          {formatModelName(m.model)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(m.input_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(m.output_tokens)}
                        </td>
                        <td
                          className="py-2 text-right tabular-nums text-zinc-300"
                          title={
                            isTokens
                              ? undefined
                              : buildCostCellTooltip(
                                  m.cost_cents_ingested,
                                  m.cost_cents
                                )
                          }
                        >
                          {fmtValue(
                            m.cost_cents,
                            m.input_tokens + m.output_tokens
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="divide-y divide-white/5 text-sm sm:hidden">
                  {models.map((m, i) => (
                    <li
                      key={`${m.provider}/${m.model}/${i}`}
                      className="flex flex-col gap-1 py-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-200">
                          {formatModelName(m.model)}
                        </span>
                        <span
                          className="tabular-nums text-zinc-300"
                          title={
                            isTokens
                              ? undefined
                              : buildCostCellTooltip(
                                  m.cost_cents_ingested,
                                  m.cost_cents
                                )
                          }
                        >
                          {fmtValue(
                            m.cost_cents,
                            m.input_tokens + m.output_tokens
                          )}
                        </span>
                      </div>
                      <div className="text-xs tabular-nums text-zinc-500">
                        {formatProvider(m.provider)} · in{" "}
                        {fmtNum(m.input_tokens)} · out {fmtNum(m.output_tokens)}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{`${valueWord} by Surface`}</CardTitle>
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
                  : `No surface ${valueWord.toLowerCase()} data for this period`
            }
            unit={unit}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Model Count</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-[auto,1fr] sm:items-center">
            <StatCard title="Active models" value={activeModelsLabel} />
            <ModelCountChart data={modelActivity} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{perModelTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-[auto,1fr] sm:items-center">
            <StatCard
              title={isTokens ? "Avg tokens per model" : "Avg cost per model"}
              value={avgPerModelLabel}
            />
            <CostPerModelChart data={modelActivity} unit={unit} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
