import { Suspense } from "react";
import {
  getCurrentUser,
  getCostByDevice,
  getDeviceActivityByDay,
  getEarliestActivity,
  getOrgMembers,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import { deviceLabel, fmtCost, fmtNum } from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { UserFilter } from "@/components/user-filter";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
import { DeviceCountChart } from "@/components/charts/device-count-chart";
import { CostPerDeviceChart } from "@/components/charts/cost-per-device-chart";
import { StatCard } from "@/components/stat-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function DevicesPage({
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
  const [devices, deviceActivity, members] = await Promise.all([
    getCostByDevice(user, range, scope),
    getDeviceActivityByDay(user, range, scope),
    user.role === "manager" ? getOrgMembers(user.org_id) : Promise.resolve([]),
  ]);

  const showOwnerColumn = user.role === "manager";
  const isTokens = unit === "tokens";
  const valueWord = isTokens ? "Tokens" : "Cost";
  const perDeviceTitle = isTokens ? "Tokens per Device" : "Cost per Device";
  const fmtValue = (cost_cents: number, tokens: number) =>
    isTokens ? fmtNum(tokens) : fmtCost(cost_cents);

  // Mirrors the Team-page identifier label so the manager view distinguishes
  // two laptops both labelled `"laptop"` sitting under different owners.
  const labelFor = (d: (typeof devices)[number]) =>
    showOwnerColumn && d.owner_name
      ? `${deviceLabel(d.id, d.label)} — ${d.owner_name}`
      : deviceLabel(d.id, d.label);

  // Headline stats for the time-series cards. Devices that registered but
  // never pushed a rollup land in `getCostByDevice` with zero cost/tokens; we
  // exclude them from the period-level "active" reading and the per-device
  // average so the numbers match the bar chart's `cost > 0 || tokens > 0`
  // filter (mirrors the Team-page `UNASSIGNED` exclusion at #131).
  const activeDevices = devices.filter(
    (d) => d.cost_cents > 0 || d.input_tokens + d.output_tokens > 0
  );
  const distinctActiveDevices = activeDevices.length;
  const totalCostCents = activeDevices.reduce((s, d) => s + d.cost_cents, 0);
  const totalTokens = activeDevices.reduce(
    (s, d) => s + d.input_tokens + d.output_tokens,
    0
  );
  const perDeviceNumerator = isTokens ? totalTokens : totalCostCents;
  const avgPerDevice =
    distinctActiveDevices > 0
      ? perDeviceNumerator / distinctActiveDevices
      : null;

  const activeDevicesLabel =
    distinctActiveDevices > 0 ? fmtNum(distinctActiveDevices) : "—";
  const avgPerDeviceLabel =
    avgPerDevice === null
      ? "—"
      : isTokens
        ? fmtNum(Math.round(avgPerDevice))
        : fmtCost(avgPerDevice);

  const chartRows = devices
    .map((d) => ({
      label: labelFor(d),
      cost_cents: d.cost_cents,
      tokens: d.input_tokens + d.output_tokens,
    }))
    .filter((d) => d.cost_cents > 0 || d.tokens > 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Devices</h1>
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
          <CardTitle>{`${valueWord} by Device`}</CardTitle>
        </CardHeader>
        <CardContent>
          {chartRows.length === 0 ? (
            <CostBarChart
              data={[]}
              emptyLabel={`No device ${valueWord.toLowerCase()} data for this period`}
              unit={unit}
            />
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <CostBarChart
                data={chartRows}
                emptyLabel={`No device ${valueWord.toLowerCase()} data for this period`}
                unit={unit}
              />
              <div>
                <table className="hidden w-full text-sm sm:table">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-zinc-400">
                      <th className="pb-2 font-medium">Device</th>
                      <th className="pb-2 text-right font-medium">
                        {valueWord}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.id} className="border-b border-white/5">
                        <td className="py-2 text-zinc-200">{labelFor(d)}</td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {fmtValue(
                            d.cost_cents,
                            d.input_tokens + d.output_tokens
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="divide-y divide-white/5 text-sm sm:hidden">
                  {devices.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="text-zinc-200">{labelFor(d)}</span>
                      <span className="tabular-nums text-zinc-300">
                        {fmtValue(
                          d.cost_cents,
                          d.input_tokens + d.output_tokens
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
          <CardTitle>Device Count</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-[auto,1fr] sm:items-center">
            <StatCard title="Active devices" value={activeDevicesLabel} />
            <DeviceCountChart data={deviceActivity} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{perDeviceTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-[auto,1fr] sm:items-center">
            <StatCard
              title={isTokens ? "Avg tokens per device" : "Avg cost per device"}
              value={avgPerDeviceLabel}
            />
            <CostPerDeviceChart data={deviceActivity} unit={unit} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
