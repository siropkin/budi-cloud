import { Suspense } from "react";
import {
  getCurrentUser,
  getCostByDevice,
  getEarliestActivity,
  getOrgMembers,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { deviceLabel, fmtCost, fmtRelative } from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UserFilter } from "@/components/user-filter";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; user?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user?.org_id) return null;

  const scope = { scopedUserId: params.user || null };
  const earliestActivity =
    params.days === ALL_PERIOD_VALUE
      ? await getEarliestActivity(user, scope)
      : null;
  const tz = await getViewerTimeZone();
  const range = dateRangeFromDays(params.days, earliestActivity, tz);
  const [devices, members] = await Promise.all([
    getCostByDevice(user, range, scope),
    user.role === "manager" ? getOrgMembers(user.org_id) : Promise.resolve([]),
  ]);

  const showOwnerColumn = user.role === "manager";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Devices</h1>
        <Suspense>
          <div className="flex items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cost by Device</CardTitle>
        </CardHeader>
        <CardContent>
          <CostBarChart
            data={devices
              .filter((d) => d.cost_cents > 0)
              .map((d) => ({
                label:
                  showOwnerColumn && d.owner_name
                    ? `${deviceLabel(d.id, d.label)} — ${d.owner_name}`
                    : deviceLabel(d.id, d.label),
                cost_cents: d.cost_cents,
              }))}
            emptyLabel="No device cost data for this period"
          />
        </CardContent>
      </Card>

      {devices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Devices</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="hidden w-full text-sm sm:table">
              <thead>
                <tr className="border-b border-white/10 text-left text-zinc-400">
                  <th className="pb-2 font-medium">Device</th>
                  {showOwnerColumn && (
                    <th className="pb-2 font-medium">Owner</th>
                  )}
                  <th className="pb-2 font-medium">Last seen</th>
                  <th className="pb-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-b border-white/5">
                    <td className="py-2 text-zinc-200">
                      {deviceLabel(d.id, d.label)}
                    </td>
                    {showOwnerColumn && (
                      <td className="py-2 text-zinc-300">
                        {d.owner_name ?? "—"}
                      </td>
                    )}
                    <td className="py-2 text-zinc-400">
                      {fmtRelative(d.last_seen)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-zinc-300">
                      {fmtCost(d.cost_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-white/5 text-sm sm:hidden">
              {devices.map((d) => (
                <li key={d.id} className="flex flex-col gap-0.5 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-200">
                      {deviceLabel(d.id, d.label)}
                    </span>
                    <span className="tabular-nums text-zinc-300">
                      {fmtCost(d.cost_cents)}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500">
                    {showOwnerColumn && d.owner_name
                      ? `${d.owner_name} · ${fmtRelative(d.last_seen)}`
                      : fmtRelative(d.last_seen)}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
