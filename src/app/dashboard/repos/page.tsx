import { Suspense } from "react";
import {
  getCurrentUser,
  getCostByRepo,
  getCostByBranch,
  getCostByTicket,
  getEarliestActivity,
  getOrgMembers,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { parseUnit } from "@/lib/units";
import { repoName } from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UnitsSelector } from "@/components/units-selector";
import { UserFilter } from "@/components/user-filter";
import { CostBarChart } from "@/components/charts/cost-bar-chart";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default async function ReposPage({
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
  const [repos, branches, tickets, members] = await Promise.all([
    getCostByRepo(user, range, scope),
    getCostByBranch(user, range, scope),
    getCostByTicket(user, range, scope),
    user.role === "manager" ? getOrgMembers(user.org_id) : Promise.resolve([]),
  ]);

  // Multiple raw `repo_id` sentinels can collapse to the same display label
  // (e.g. `"Unassigned"` and `"(untagged)"` both render as `"(no repo)"`),
  // which would otherwise show up as duplicate bars. Merge by label so the
  // chart has one row per bucket the user actually sees.
  const repoBuckets = new Map<string, { cost_cents: number; tokens: number }>();
  for (const r of repos) {
    const label = repoName(r.repo_id);
    const tokens = r.input_tokens + r.output_tokens;
    const existing = repoBuckets.get(label);
    if (existing) {
      existing.cost_cents += r.cost_cents;
      existing.tokens += tokens;
    } else {
      repoBuckets.set(label, { cost_cents: r.cost_cents, tokens });
    }
  }
  const repoChartData = Array.from(repoBuckets, ([label, totals]) => ({
    label,
    cost_cents: totals.cost_cents,
    tokens: totals.tokens,
  })).sort((a, b) => b.cost_cents - a.cost_cents);

  const valueWord = unit === "tokens" ? "Tokens" : "Cost";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Repos</h1>
        <Suspense>
          <div className="flex flex-wrap items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <UnitsSelector />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{`${valueWord} by Project`}</CardTitle>
          </CardHeader>
          <CardContent>
            <CostBarChart
              data={repoChartData}
              emptyLabel="No project data for this period"
              unit={unit}
            />
            <p className="mt-3 text-xs text-zinc-500">
              <span className="text-zinc-400">(no repo)</span> aggregates spend
              from sessions whose directory didn&rsquo;t map to a known git
              remote. Your local Budi&rsquo;s privacy layer strips the repo
              identifier in that case; see{" "}
              <a
                className="underline decoration-dotted underline-offset-2 hover:text-zinc-300"
                href="https://github.com/siropkin/budi/blob/main/docs/adr/0083-cloud-ingest-identity-and-privacy-contract.md"
                target="_blank"
                rel="noreferrer"
              >
                ADR-0083
              </a>
              .
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{`${valueWord} by Branch`}</CardTitle>
          </CardHeader>
          <CardContent>
            <CostBarChart
              data={branches.map((b) => ({
                label: `${repoName(b.repo_id)} / ${b.git_branch.replace(/^refs\/heads\//, "")}`,
                cost_cents: b.cost_cents,
                tokens: b.input_tokens + b.output_tokens,
              }))}
              emptyLabel="No branch data for this period"
              unit={unit}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{`${valueWord} by Ticket`}</CardTitle>
        </CardHeader>
        <CardContent>
          <CostBarChart
            data={tickets.map((t) => ({
              label: t.ticket,
              cost_cents: t.cost_cents,
              tokens: t.input_tokens + t.output_tokens,
            }))}
            emptyLabel="No ticket data for this period"
            unit={unit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
