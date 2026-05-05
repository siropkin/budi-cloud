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
import { fmtCost } from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
import { TeamCountChart } from "@/components/charts/team-count-chart";
import { CostPerPersonChart } from "@/components/charts/cost-per-person-chart";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.org_id) return null;
  // Defense-in-depth alongside the sidebar gating in `components/sidebar.tsx`:
  // the page is scoped to the viewer's own devices (ADR-0083 §6), so for a
  // member it can only ever show themselves — send them back to Overview (#64).
  if (user.role !== "manager") redirect("/dashboard");

  const earliestActivity =
    params.days === ALL_PERIOD_VALUE ? await getEarliestActivity(user) : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  const [userCosts, teamActivity] = await Promise.all([
    getCostByUser(user, range),
    getTeamActivityByDay(user, range),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Team</h1>
        <Suspense>
          <PeriodSelector />
        </Suspense>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cost by Team Member</CardTitle>
        </CardHeader>
        <CardContent>
          <CostBarChart
            data={userCosts.map((u) => ({
              label: u.name,
              cost_cents: u.cost_cents,
            }))}
            emptyLabel="No team cost data for this period"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Team Count</CardTitle>
        </CardHeader>
        <CardContent>
          <TeamCountChart data={teamActivity} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cost per Person</CardTitle>
        </CardHeader>
        <CardContent>
          <CostPerPersonChart data={teamActivity} />
        </CardContent>
      </Card>

      {userCosts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Team Members</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Table on sm+; stacked rows below. */}
            <table className="hidden w-full text-sm sm:table">
              <thead>
                <tr className="border-b border-white/10 text-left text-zinc-400">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {userCosts.map((u, i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="py-2 text-zinc-200">{u.name}</td>
                    <td className="py-2 text-right tabular-nums text-zinc-300">
                      {fmtCost(u.cost_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-white/5 text-sm sm:hidden">
              {userCosts.map((u, i) => (
                <li key={i} className="flex items-center justify-between py-2">
                  <span className="text-zinc-200">{u.name}</span>
                  <span className="tabular-nums text-zinc-300">
                    {fmtCost(u.cost_cents)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
