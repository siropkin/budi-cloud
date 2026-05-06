import { Suspense } from "react";
import {
  getCurrentUser,
  getCostByModel,
  getModelActivityByDay,
  getEarliestActivity,
  getOrgMembers,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import { fmtCost, fmtNum, formatModelName } from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { UserFilter } from "@/components/user-filter";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
import { ModelCountChart } from "@/components/charts/model-count-chart";
import { CostPerModelChart } from "@/components/charts/cost-per-model-chart";
import { StatCard } from "@/components/stat-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; user?: string; units?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const unit = parseUnit(params.units);
  const scope = { scopedUserId: params.user || null };
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE
      ? await getEarliestActivity(user, scope)
      : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  const [models, modelActivity, members] = await Promise.all([
    getCostByModel(user, range, scope),
    getModelActivityByDay(user, range, scope),
    user.role === "manager" ? getOrgMembers(user.org_id) : Promise.resolve([]),
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Models</h1>
        <Suspense>
          <div className="flex flex-wrap items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <UnitsSelector />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

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
                        <td className="py-2 text-zinc-200">{m.provider}</td>
                        <td className="py-2 text-zinc-200">
                          {formatModelName(m.model)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(m.input_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(m.output_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
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
                        <span className="tabular-nums text-zinc-300">
                          {fmtValue(
                            m.cost_cents,
                            m.input_tokens + m.output_tokens
                          )}
                        </span>
                      </div>
                      <div className="text-xs tabular-nums text-zinc-500">
                        {m.provider} · in {fmtNum(m.input_tokens)} · out{" "}
                        {fmtNum(m.output_tokens)}
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
