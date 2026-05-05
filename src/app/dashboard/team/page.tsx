import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  getCurrentUser,
  getCostByUser,
  getEarliestActivity,
  getTeamActivityByDay,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import { fmtCost, fmtNum } from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
import { TeamCountChart } from "@/components/charts/team-count-chart";
import { CostPerPersonChart } from "@/components/charts/cost-per-person-chart";
import { StatCard } from "@/components/stat-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; units?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.org_id) return null;
  // Defense-in-depth alongside the sidebar gating in `components/sidebar.tsx`:
  // the page is scoped to the viewer's own devices (ADR-0083 §6), so for a
  // member it can only ever show themselves — send them back to Overview (#64).
  if (user.role !== "manager") redirect("/dashboard");

  const unit = parseUnit(params.units);
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE ? await getEarliestActivity(user) : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  const [userCosts, teamActivity] = await Promise.all([
    getCostByUser(user, range),
    getTeamActivityByDay(user, range),
  ]);

  const isTokens = unit === "tokens";
  const valueWord = isTokens ? "Tokens" : "Cost";
  const perPersonTitle = isTokens ? "Tokens per Person" : "Cost per Person";
  const fmtValue = (cost_cents: number, tokens: number) =>
    isTokens ? fmtNum(tokens) : fmtCost(cost_cents);

  // Headline averages for the time-series cards (#131). "Avg active members"
  // is the mean of the daily distinct-member counts over days that have data
  // (empty days are dropped upstream, so we divide by the row count). Avg
  // per-person matches the chart's per-day formula: total numerator divided
  // by total active-member-days, so the headline reads as the period-level
  // weighted average of the curve below it.
  const dayCount = teamActivity.length;
  const totalActiveMemberDays = teamActivity.reduce(
    (s, d) => s + d.active_members,
    0
  );
  const totalCostCents = teamActivity.reduce((s, d) => s + d.cost_cents, 0);
  const totalTokens = teamActivity.reduce(
    (s, d) => s + d.input_tokens + d.output_tokens,
    0
  );
  const avgActiveMembers =
    dayCount > 0 ? totalActiveMemberDays / dayCount : null;
  const perPersonNumerator = isTokens ? totalTokens : totalCostCents;
  const avgPerPerson =
    totalActiveMemberDays > 0
      ? perPersonNumerator / totalActiveMemberDays
      : null;

  const avgActiveMembersLabel =
    avgActiveMembers === null
      ? "—"
      : avgActiveMembers.toLocaleString("en-US", {
          maximumFractionDigits: 1,
        });
  const avgPerPersonLabel =
    avgPerPerson === null
      ? "—"
      : isTokens
        ? fmtNum(Math.round(avgPerPerson))
        : fmtCost(avgPerPerson);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Team</h1>
        <Suspense>
          <div className="flex flex-wrap items-center gap-3">
            <UnitsSelector />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{`${valueWord} by Team Member`}</CardTitle>
        </CardHeader>
        <CardContent>
          {userCosts.length === 0 ? (
            <CostBarChart
              data={[]}
              emptyLabel="No team cost data for this period"
              unit={unit}
            />
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <CostBarChart
                data={userCosts.map((u) => ({
                  label: u.name,
                  cost_cents: u.cost_cents,
                  tokens: u.input_tokens + u.output_tokens,
                }))}
                emptyLabel="No team cost data for this period"
                unit={unit}
              />
              <div>
                <table className="hidden w-full text-sm sm:table">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-zinc-400">
                      <th className="pb-2 font-medium">Name</th>
                      <th className="pb-2 text-right font-medium">
                        {valueWord}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {userCosts.map((u, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-2 text-zinc-200">{u.name}</td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {fmtValue(
                            u.cost_cents,
                            u.input_tokens + u.output_tokens
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="divide-y divide-white/5 text-sm sm:hidden">
                  {userCosts.map((u, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="text-zinc-200">{u.name}</span>
                      <span className="tabular-nums text-zinc-300">
                        {fmtValue(
                          u.cost_cents,
                          u.input_tokens + u.output_tokens
                        )}
                      </span>
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
          <CardTitle>Team Count</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-[auto,1fr] sm:items-center">
            <StatCard
              title="Avg active members"
              value={avgActiveMembersLabel}
            />
            <TeamCountChart data={teamActivity} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{perPersonTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-[auto,1fr] sm:items-center">
            <StatCard
              title={isTokens ? "Avg tokens per person" : "Avg cost per person"}
              value={avgPerPersonLabel}
            />
            <CostPerPersonChart data={teamActivity} unit={unit} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
