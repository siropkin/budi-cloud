import { Suspense } from "react";
import {
  getCurrentUser,
  getCostByModel,
  getEarliestActivity,
  getOrgMembers,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import { formatModelName } from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { UserFilter } from "@/components/user-filter";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
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
  const [models, members] = await Promise.all([
    getCostByModel(user, range, scope),
    user.role === "manager" ? getOrgMembers(user.org_id) : Promise.resolve([]),
  ]);

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
          <CardTitle>{`${unit === "tokens" ? "Tokens" : "Cost"} by Model`}</CardTitle>
        </CardHeader>
        <CardContent>
          <CostBarChart
            data={models.map((m) => ({
              label: `${m.provider} / ${formatModelName(m.model)}`,
              cost_cents: m.cost_cents,
              tokens: m.input_tokens + m.output_tokens,
            }))}
            emptyLabel="No model data for this period"
            unit={unit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
