import { Suspense } from "react";
import {
  getCurrentUser,
  getEarliestActivity,
  getOrgMembers,
  getSessions,
} from "@/lib/dal";
import { dateRangeFromDays } from "@/lib/date-range";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { ALL_PERIOD_VALUE } from "@/lib/periods";
import { fmtCost, fmtNum, repoName } from "@/lib/format";
import { PeriodSelector } from "@/components/period-selector";
import { UserFilter } from "@/components/user-filter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

function formatDuration(ms: number | null): string {
  if (!ms) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return `${hours}h ${remaining}m`;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function SessionsPage({
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
  const [sessions, members] = await Promise.all([
    getSessions(user, range, scope),
    user.role === "manager" ? getOrgMembers(user.org_id) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Sessions</h1>
        <Suspense>
          <div className="flex items-center gap-3">
            <UserFilter members={members} role={user.role} />
            <PeriodSelector />
          </div>
        </Suspense>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Recent Sessions ({sessions.length}
            {sessions.length === 100 ? "+" : ""})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">
              No sessions found for this period
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-zinc-400">
                    <th className="pb-2 font-medium">Provider</th>
                    <th className="pb-2 font-medium">Started</th>
                    <th className="pb-2 font-medium">Duration</th>
                    <th className="pb-2 font-medium">Repo</th>
                    <th className="pb-2 font-medium">Branch</th>
                    <th className="pb-2 text-right font-medium">Messages</th>
                    <th className="pb-2 text-right font-medium">Tokens</th>
                    <th className="pb-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr
                      key={`${s.device_id}-${s.session_id}`}
                      className="border-b border-white/5"
                    >
                      <td className="py-2 text-zinc-300">{s.provider}</td>
                      <td className="py-2 text-zinc-400">
                        {formatTimestamp(s.started_at)}
                      </td>
                      <td className="py-2 text-zinc-400">
                        {formatDuration(s.duration_ms)}
                      </td>
                      <td className="py-2 text-zinc-400">
                        {repoName(s.repo_id)}
                      </td>
                      <td className="py-2 text-zinc-400">
                        {s.git_branch?.replace(/^refs\/heads\//, "") || "-"}
                      </td>
                      <td className="py-2 text-right tabular-nums text-zinc-300">
                        {fmtNum(s.message_count)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-zinc-300">
                        {fmtNum(
                          Number(s.total_input_tokens) +
                            Number(s.total_output_tokens)
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums text-zinc-200">
                        {fmtCost(Number(s.total_cost_cents))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
