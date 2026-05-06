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
import { fmtCost, fmtNum, repoName } from "@/lib/format";
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

  const isTokens = unit === "tokens";
  const valueWord = isTokens ? "Tokens" : "Cost";
  const fmtValue = (cost_cents: number, tokens: number) =>
    isTokens ? fmtNum(tokens) : fmtCost(cost_cents);

  // Multiple raw `repo_id` sentinels can collapse to the same display label
  // (e.g. `"Unassigned"` and `"(untagged)"` both render as `"(no repo)"`),
  // which would otherwise show up as duplicate bars and table rows. Merge by
  // label so the chart and the companion table both show one row per bucket
  // the user actually sees.
  const repoBuckets = new Map<
    string,
    { cost_cents: number; input_tokens: number; output_tokens: number }
  >();
  for (const r of repos) {
    const label = repoName(r.repo_id);
    const existing = repoBuckets.get(label);
    if (existing) {
      existing.cost_cents += r.cost_cents;
      existing.input_tokens += r.input_tokens;
      existing.output_tokens += r.output_tokens;
    } else {
      repoBuckets.set(label, {
        cost_cents: r.cost_cents,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
      });
    }
  }
  const repoRows = Array.from(repoBuckets, ([label, totals]) => ({
    label,
    cost_cents: totals.cost_cents,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
  })).sort((a, b) => b.cost_cents - a.cost_cents);

  const branchRows = branches.map((b) => ({
    project: repoName(b.repo_id),
    branch: b.git_branch.replace(/^refs\/heads\//, ""),
    cost_cents: b.cost_cents,
    input_tokens: b.input_tokens,
    output_tokens: b.output_tokens,
  }));

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

      <Card>
        <CardHeader>
          <CardTitle>{`${valueWord} by Project`}</CardTitle>
        </CardHeader>
        <CardContent>
          {repoRows.length === 0 ? (
            <CostBarChart
              data={[]}
              emptyLabel="No project data for this period"
              unit={unit}
            />
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <CostBarChart
                data={repoRows.map((r) => ({
                  label: r.label,
                  cost_cents: r.cost_cents,
                  tokens: r.input_tokens + r.output_tokens,
                }))}
                emptyLabel="No project data for this period"
                unit={unit}
              />
              <div>
                <table className="hidden w-full text-sm sm:table">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-zinc-400">
                      <th className="pb-2 font-medium">Project</th>
                      <th className="pb-2 text-right font-medium">In</th>
                      <th className="pb-2 text-right font-medium">Out</th>
                      <th className="pb-2 text-right font-medium">
                        {valueWord}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {repoRows.map((r, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-2 text-zinc-200">{r.label}</td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(r.input_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(r.output_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {fmtValue(
                            r.cost_cents,
                            r.input_tokens + r.output_tokens
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="divide-y divide-white/5 text-sm sm:hidden">
                  {repoRows.map((r, i) => (
                    <li key={i} className="flex flex-col gap-1 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-200">{r.label}</span>
                        <span className="tabular-nums text-zinc-300">
                          {fmtValue(
                            r.cost_cents,
                            r.input_tokens + r.output_tokens
                          )}
                        </span>
                      </div>
                      <div className="text-xs tabular-nums text-zinc-500">
                        in {fmtNum(r.input_tokens)} · out{" "}
                        {fmtNum(r.output_tokens)}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
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
          {branchRows.length === 0 ? (
            <CostBarChart
              data={[]}
              emptyLabel="No branch data for this period"
              unit={unit}
            />
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <CostBarChart
                data={branchRows.map((b) => ({
                  label: `${b.project} / ${b.branch}`,
                  cost_cents: b.cost_cents,
                  tokens: b.input_tokens + b.output_tokens,
                }))}
                emptyLabel="No branch data for this period"
                unit={unit}
              />
              <div>
                <table className="hidden w-full text-sm sm:table">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-zinc-400">
                      <th className="pb-2 font-medium">Project</th>
                      <th className="pb-2 font-medium">Branch</th>
                      <th className="pb-2 text-right font-medium">In</th>
                      <th className="pb-2 text-right font-medium">Out</th>
                      <th className="pb-2 text-right font-medium">
                        {valueWord}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {branchRows.map((b, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-2 text-zinc-200">{b.project}</td>
                        <td className="py-2 text-zinc-200">{b.branch}</td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(b.input_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(b.output_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {fmtValue(
                            b.cost_cents,
                            b.input_tokens + b.output_tokens
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="divide-y divide-white/5 text-sm sm:hidden">
                  {branchRows.map((b, i) => (
                    <li key={i} className="flex flex-col gap-1 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-200">
                          {b.project} / {b.branch}
                        </span>
                        <span className="tabular-nums text-zinc-300">
                          {fmtValue(
                            b.cost_cents,
                            b.input_tokens + b.output_tokens
                          )}
                        </span>
                      </div>
                      <div className="text-xs tabular-nums text-zinc-500">
                        in {fmtNum(b.input_tokens)} · out{" "}
                        {fmtNum(b.output_tokens)}
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
          <CardTitle>{`${valueWord} by Ticket`}</CardTitle>
        </CardHeader>
        <CardContent>
          {tickets.length === 0 ? (
            <CostBarChart
              data={[]}
              emptyLabel="No ticket data for this period"
              unit={unit}
            />
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <CostBarChart
                data={tickets.map((t) => ({
                  label: t.ticket,
                  cost_cents: t.cost_cents,
                  tokens: t.input_tokens + t.output_tokens,
                }))}
                emptyLabel="No ticket data for this period"
                unit={unit}
              />
              <div>
                <table className="hidden w-full text-sm sm:table">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-zinc-400">
                      <th className="pb-2 font-medium">Ticket</th>
                      <th className="pb-2 text-right font-medium">In</th>
                      <th className="pb-2 text-right font-medium">Out</th>
                      <th className="pb-2 text-right font-medium">
                        {valueWord}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((t, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-2 text-zinc-200">{t.ticket}</td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(t.input_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-400">
                          {fmtNum(t.output_tokens)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-zinc-300">
                          {fmtValue(
                            t.cost_cents,
                            t.input_tokens + t.output_tokens
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="divide-y divide-white/5 text-sm sm:hidden">
                  {tickets.map((t, i) => (
                    <li key={i} className="flex flex-col gap-1 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-200">{t.ticket}</span>
                        <span className="tabular-nums text-zinc-300">
                          {fmtValue(
                            t.cost_cents,
                            t.input_tokens + t.output_tokens
                          )}
                        </span>
                      </div>
                      <div className="text-xs tabular-nums text-zinc-500">
                        in {fmtNum(t.input_tokens)} · out{" "}
                        {fmtNum(t.output_tokens)}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
